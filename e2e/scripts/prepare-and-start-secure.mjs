#!/usr/bin/env node
/**
 * production과 동일한 조건(NODE_ENV=production + HTTPS + Secure 쿠키)에서 핵심 흐름을
 * 확인하기 위한 두 번째 E2E 서버다(요구사항2.md §12 E2E 7번).
 *
 * 실제 배포 구성과 같은 모양을 만든다:
 *   브라우저 --HTTPS--> (자체 서명 인증서를 쓰는 로컬 TLS 종단 프록시) --HTTP--> 앱(:4175)
 * 프록시는 Nginx가 넘겨주어야 하는 헤더(Host / X-Real-IP / X-Forwarded-For /
 * X-Forwarded-Proto)와 WebSocket upgrade를 그대로 전달한다 — README 배포 절과 동일하다.
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverDir = path.join(repoRoot, "server");
const certDir = path.join(repoRoot, "e2e", ".certs");
const dbFile = path.join(serverDir, "prisma", "e2e-secure.db");

const APP_PORT = 4175;
const TLS_PORT = 4443;

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const p = dbFile + suffix;
  if (existsSync(p)) rmSync(p);
}

// ---------- 자체 서명 인증서 ----------
mkdirSync(certDir, { recursive: true });
const keyPath = path.join(certDir, "e2e-key.pem");
const certPath = path.join(certDir, "e2e-cert.pem");
if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.log("[e2e-secure] 자체 서명 인증서 생성 중...");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 30 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
    { stdio: "inherit" },
  );
}

// ---------- production 기준을 통과하는 환경변수 ----------
// assertProductionEnv()가 요구하는 조건(32자 이상 secret, 15자 이상 ADMIN 비밀번호)을
// 모두 만족해야 서버가 뜬다. 여기 값은 로컬 E2E 전용이며 실제 운영에 쓰이지 않는다.
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(APP_PORT),
  DATABASE_URL: `file:${dbFile}?connection_limit=1`,
  SESSION_SECRET: "e2e-secure-session-secret-value-0123456789abcdef",
  AUDIT_HMAC_KEY: "e2e-secure-audit-hmac-key-value-0123456789abcdef",
  MFA_ENCRYPTION_KEY: "e2e-secure-mfa-encryption-key-0123456789abcdef",
  ADMINID: "admin",
  ADMINPASSWORD: "e2e-secure-admin-initial-pw-01",
  // 직원 계정은 시드되지 않는다 — 스펙이 ADMIN(MFA 완료)으로 관리자 API를 호출해 만든다.
  STAFF_LOGIN_RATE_LIMIT_PER_5MIN: "100000",
  SENSITIVE_AUTH_RATE_LIMIT_PER_10MIN: "100000",
  CUSTOMER_RATE_LIMIT_PER_MIN: "100000",
};

console.log("[e2e-secure] migrating database...");
execSync("npx prisma migrate deploy", { cwd: serverDir, stdio: "inherit", env });

console.log("[e2e-secure] seeding bootstrap admin...");
execSync("npx tsx prisma/seed.ts", { cwd: serverDir, stdio: "inherit", env });

console.log(`[e2e-secure] starting app on :${APP_PORT} (NODE_ENV=production)...`);
// 빌드된 산출물을 쓴다 — production 기동 경로를 그대로 재현하기 위함.
execSync("npm run build --workspace server", { cwd: repoRoot, stdio: "inherit", env });
const app = spawn("node", ["dist/index.js"], { cwd: serverDir, stdio: "inherit", env });

// ---------- TLS 종단 프록시 ----------
function proxyHeaders(req) {
  const forwardedFor = req.socket.remoteAddress ?? "127.0.0.1";
  return {
    ...req.headers,
    // Nginx 설정에서 반드시 넘겨야 하는 헤더들(README 참고).
    "x-real-ip": forwardedFor,
    "x-forwarded-for": forwardedFor,
    "x-forwarded-proto": "https",
  };
}

const tls = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  const upstream = http.request(
    { host: "127.0.0.1", port: APP_PORT, method: req.method, path: req.url, headers: proxyHeaders(req) },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(502).end();
  });
  req.pipe(upstream);
});

// WebSocket(Socket.IO) upgrade 전달 — 이것이 없으면 실시간 갱신이 동작하지 않는다.
tls.on("upgrade", (req, socket, head) => {
  const upstream = http.request({
    host: "127.0.0.1",
    port: APP_PORT,
    method: req.method,
    path: req.url,
    headers: proxyHeaders(req),
  });
  upstream.end();
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(upstreamRes.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("") +
        "\r\n",
    );
    if (upstreamHead?.length) socket.unshift(upstreamHead);
    upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.destroy());
});

tls.listen(TLS_PORT, "127.0.0.1", () => {
  console.log(`[e2e-secure] HTTPS proxy listening on :${TLS_PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    app.kill(sig);
    tls.close();
    process.exit(0);
  });
}

app.on("exit", (code) => {
  tls.close();
  process.exit(code ?? 0);
});
