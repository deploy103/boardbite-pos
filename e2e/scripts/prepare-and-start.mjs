#!/usr/bin/env node
// Playwright의 webServer.command로 실행된다. 격리된 SQLite DB를 새로 만들고
// (마이그레이션 + 부트스트랩 시드) 실제 서버 프로세스를 그 DB로 띄운다.
// docs/TEST-PLAN.md §3(E2E 시나리오)이 이 서버를 대상으로 실행된다.
import { execSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverDir = path.join(repoRoot, "server");
const dbFile = path.join(serverDir, "prisma", "e2e.db");

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const p = dbFile + suffix;
  if (existsSync(p)) rmSync(p);
}

const env = {
  ...process.env,
  // NODE_ENV=production으로 두면 세션 쿠키에 Secure 속성이 강제되어(server/src/app.ts,
  // docs/adr/0003-auth-session.md) 순수 HTTP로 뜨는 이 E2E 서버에서는 브라우저가 쿠키를
  // 저장/전송하지 않는다. E2E는 HTTPS 없이 로컬에서 도니 production으로 표시하지 않는다.
  NODE_ENV: "development",
  PORT: "4173",
  DATABASE_URL: `file:${dbFile}?connection_limit=1`,
  SESSION_SECRET: "e2e-test-session-secret-not-for-prod",
  ADMINID: "admin",
  ADMINPASSWORD: "e2e-admin-pw-12345678",
  FRONTID: "front",
  FRONTPW: "e2e-front-pw-12345678",
  POSID: "pos",
  POSPW: "e2e-pos-pw-12345678",
  SERVING_ID: "serving",
  SERVING_PW: "e2e-serving-pw-12345678",
};

console.log("[e2e] building client...");
execSync("npm run build --workspace client", { cwd: repoRoot, stdio: "inherit", env });

console.log("[e2e] migrating e2e database...");
execSync("npx prisma migrate deploy", { cwd: serverDir, stdio: "inherit", env });

console.log("[e2e] seeding bootstrap accounts/settings...");
execSync("npx tsx prisma/seed.ts", { cwd: serverDir, stdio: "inherit", env });

console.log("[e2e] starting server on :4173...");
const child = spawn("npx", ["tsx", "src/index.ts"], { cwd: serverDir, stdio: "inherit", env });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
    process.exit(0);
  });
}

child.on("exit", (code) => process.exit(code ?? 0));
