import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { env, isProduction } from "./env.js";
import { prisma } from "./prisma.js";
import { PrismaSessionStore } from "./auth/prismaSessionStore.js";
import { requireCustomHeader } from "./middleware/csrf.js";
import { authRouter } from "./routes/auth.routes.js";
import { customerRouter } from "./routes/customer.routes.js";
import { frontRouter } from "./routes/front.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { posRouter } from "./routes/pos.routes.js";
import { servingRouter } from "./routes/serving.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");

export function createApp() {
  const app = express();

  /**
   * X-Forwarded-For를 어디까지 신뢰할지(요구사항2.md §7.1).
   *
   * 이 값이 중요한 이유: rate limiter와 loginGuard가 전부 `req.ip`를 키로 쓴다. 프록시가 없는데도
   * XFF를 신뢰하면, 공격자가 헤더를 매 요청 다르게 위조하는 것만으로 로그인 제한과 입장 코드
   * 무차별 대입 제한을 통째로 우회할 수 있다.
   *
   * 기본값 1은 README의 표준 배포 구성(같은 호스트의 Nginx가 HTTPS를 종단하고 127.0.0.1:3000으로
   * proxy_pass)을 전제한다. 프록시 없이 앱을 직접 노출한다면(HOST_BIND=0.0.0.0) 반드시
   * `TRUST_PROXY=0`으로 두어 소켓 주소만 쓰게 해야 한다.
   */
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
        },
      },
    }),
  );

  // Docker healthcheck / 리버스 프록시 업스트림 헬스체크용 — 세션/DB 접근 없이 즉시 응답(liveness).
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // readiness(요구사항2.md §9.4) — DB까지 실제로 응답해야 트래픽을 받을 준비가 된 것으로 본다.
  // 어느 쪽도 버전/경로/스키마 같은 내부 정보를 노출하지 않는다.
  app.get("/readyz", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // 요청 추적 ID — 서버 로그와 클라이언트가 받은 오류 응답을 이어주는 유일한 연결고리다(§6.2).
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });

  app.use(express.json({ limit: "200kb" }));
  app.use(cookieParser());

  app.use(
    session({
      name: "boardbite.sid",
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: new PrismaSessionStore(),
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 12 * 60 * 60 * 1000,
      },
    }),
  );

  app.use(requireCustomHeader);

  const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: env.STAFF_LOGIN_RATE_LIMIT_PER_5MIN,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const customerLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: env.CUSTOMER_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
  });

  /**
   * join code 무차별 대입 차단(요구사항2.md §2.2).
   *
   * 코드가 6자리(10^6)이므로 IP만으로 제한하면 한 테이블을 노린 공격을 충분히 늦추지 못한다.
   * IP + 대상 테이블(slug) 조합을 키로 삼아, 같은 IP가 여러 테이블을 훑는 것도,
   * 여러 요청이 한 테이블에 집중되는 것도 함께 제한한다.
   */
  const joinLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}:${req.params.slug ?? req.path}`,
    message: { error: "입장 코드 시도가 너무 많아요. 잠시 후 다시 시도해 주세요." },
  });

  /**
   * 2단계 인증·재인증 계열 엔드포인트 보호(요구사항2.md §2.5).
   *
   * loginLimiter는 `/api/staff/login`에만 걸리므로, 비밀번호를 이미 손에 넣은 공격자는
   * TOTP 6자리(10^6, 허용 오차창 포함 3개)를 제한 없이 시도할 수 있었다. 5분짜리 pending
   * 창 안에서 초당 수백 번을 던지면 2단계 인증이 사실상 무력화된다.
   *
   * 실질적인 차단은 auth.routes.ts의 세션 단위 실패 카운터(한도 초과 시 pending/세션 폐기)가
   * 담당하고, 이 limiter는 그 앞단에서 대량 트래픽 자체를 끊는 역할이다. 직원 단말이 모두
   * 같은 공유기를 쓰는 환경을 감안해 정상 사용은 걸리지 않을 만큼 여유를 둔다.
   */
  const sensitiveAuthLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: env.SENSITIVE_AUTH_RATE_LIMIT_PER_10MIN,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "인증 시도가 너무 많아요. 잠시 후 다시 시도해 주세요." },
  });

  app.use("/api/staff/login", loginLimiter);
  for (const path of [
    "/api/staff/mfa/verify",
    "/api/staff/mfa/setup",
    "/api/staff/mfa/enable",
    "/api/staff/step-up",
    "/api/staff/change-password",
  ]) {
    app.use(path, sensitiveAuthLimiter);
  }
  /**
   * 쿠폰 번호 조회 제한(요구사항.md §8). 3자리 번호는 추측 가능하므로 인증된 직원이라도
   * 전수조사를 할 수 없어야 한다. 로그인 세션이 있으면 직원 단위로, 없으면 IP 단위로 센다
   * (미인증 요청은 어차피 staffGate에서 401이지만 limiter가 먼저 트래픽을 끊는다).
   */
  const couponLookupLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: env.COUPON_LOOKUP_RATE_LIMIT_PER_5MIN,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `coupon:${req.session?.staffUserId ?? req.ip}`,
    message: { error: "쿠폰 조회를 너무 많이 시도했어요. 잠시 후 다시 시도해 주세요." },
  });
  // 쿠폰 번호로 조회하는 경로는 전부 같은 제한을 받는다.
  // 현장 결제(GET /counter/coupons/:code)와 테이블 정산 미리보기(POST .../coupon/preview) 모두
  // "이 번호가 살아있는가"를 알려주므로, 한쪽만 막으면 다른 쪽으로 전수조사를 할 수 있다.
  app.use("/api/staff/front/counter/coupons", couponLookupLimiter);
  app.use(/^\/api\/staff\/front\/table-sessions\/[^/]+\/coupon(\/preview)?$/, couponLookupLimiter);

  app.use("/api/customer", customerLimiter);
  app.post("/api/customer/join/:slug", joinLimiter);

  /**
   * API 응답은 절대 캐시하지 않는다(요구사항2.md §6.1).
   *
   * 공유 단말/프록시가 이전 손님의 주문 내역이나 직원 화면을 그대로 되살리는 사고를 막는 것이
   * 목적이므로, 민감 경로를 하나씩 열거하는 대신 /api 전체에 일괄 적용한다.
   */
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use("/api/staff", authRouter);
  app.use("/api/customer", customerRouter);
  app.use("/api/staff/front", frontRouter);
  app.use("/api/staff/admin", adminRouter);
  app.use("/api/staff/pos", posRouter);
  app.use("/api/staff/serving", servingRouter);

  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  /**
   * 마지막 안전망(요구사항2.md §6.2).
   *
   * 클라이언트에게는 stack trace / Prisma 오류 코드 / DB 경로 같은 내부 정보를 절대 주지 않고,
   * 추적용 requestId만 함께 내려준다. 상세 내용은 서버 로그에서 같은 ID로 찾는다.
   */
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(`[${req.requestId ?? "-"}] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;

    // body-parser 등 미들웨어가 붙이는 표준 HTTP 상태는 보존한다 — 본문 초과(413)나
    // 잘못된 JSON(400)까지 500으로 뭉뚱그리면 호출자가 재시도 여부를 판단할 수 없다.
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    const clientError = status >= 400 && status < 500;

    res.status(clientError ? status : 500).json({
      // 4xx라도 서버가 만든 문구만 내려보낸다(라이브러리 메시지에 내부 정보가 섞일 수 있다).
      error: clientError
        ? "요청을 처리할 수 없습니다. 입력값을 확인해 주세요."
        : "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      requestId: req.requestId,
    });
  });

  return app;
}
