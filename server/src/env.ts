import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { isForbiddenValue, validatePasswordPolicy } from "./auth/passwordPolicy.js";

// 모노레포 루트의 .env 하나만 사용한다(server/dist, server/src 어디서 실행되든 동일 경로로 해석됨).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(8, "SESSION_SECRET은 최소 8자 이상이어야 합니다."),

  /** 감사 로그 HMAC 체인 키(요구사항2.md §5.2). production에서는 필수. */
  AUDIT_HMAC_KEY: z.string().optional(),
  /** TOTP secret 봉인용 AES-256-GCM 키(요구사항2.md §2.5.1). production에서는 필수. */
  MFA_ENCRYPTION_KEY: z.string().optional(),

  /**
   * 손님 API의 IP당 분당 허용 요청 수. 학교 축제처럼 손님 수십 명이 같은 공유기(=같은 공인 IP)를
   * 쓰는 환경에서는 기본값이 너무 빡빡할 수 있어 운영자가 조정할 수 있게 열어둔다.
   * join code 무차별 대입 제한(app.ts joinLimiter)은 이 값과 무관하게 항상 고정이다.
   */
  CUSTOMER_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).default(60),

  /**
   * 로그인 API의 IP당 5분 허용 횟수. 직원 단말이 모두 같은 공유기를 쓰면 기본값이 걸릴 수 있다.
   * 이 값은 "한 IP에서 과도한 트래픽"을 막는 1차 방어일 뿐이고, 실제 brute force 방어는
   * DB 기반 loginGuard(계정+IP 조합, 지수 backoff)가 담당하므로 조정해도 방어력이 사라지지 않는다.
   */
  STAFF_LOGIN_RATE_LIMIT_PER_5MIN: z.coerce.number().int().min(5).default(20),

  /**
   * Express `trust proxy` 설정값. rate limiter와 loginGuard가 쓰는 `req.ip`를 결정한다.
   *
   * 기본값 1 = "앞단 프록시 1대를 신뢰"(README의 Nginx 배포 구성).
   * 프록시 없이 직접 노출하는 경우 반드시 0으로 둔다 — 그러지 않으면 클라이언트가 보낸
   * X-Forwarded-For가 그대로 req.ip가 되어 IP 기반 제한이 전부 무력화된다.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

  /**
   * MFA 인증번호 확인 / step-up 재인증 / 비밀번호 변경의 IP당 10분 허용 횟수.
   * 정상 운영에서는 닿을 일이 없는 값이지만, 직원 단말이 전부 같은 공유기를 쓰는 환경이라면
   * 올릴 수 있게 열어둔다. 실제 무차별 대입 차단은 이 값과 무관하게 세션 단위 실패 카운터
   * (auth.routes.ts)가 담당하므로, 올려도 방어력이 사라지지 않는다.
   */
  SENSITIVE_AUTH_RATE_LIMIT_PER_10MIN: z.coerce.number().int().min(5).default(40),

  /**
   * 부트스트랩 관리자 계정. 시드가 만드는 유일한 계정이며, FRONT/POS/SERVING 계정은
   * 환경변수로 만들지 않는다 — 운영자가 로그인한 뒤 관리자 화면에서 직접 등록한다.
   * 그래야 감사 로그에 "누가 만든 계정인지"가 남고, 아무도 안 쓰는 공용 계정이 방치되지 않는다.
   */
  ADMINID: z.string().min(1),
  ADMINPASSWORD: z.string().min(1),
});

export const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

// 비밀번호 정책은 auth/passwordPolicy.ts가 단일 출처다. 기존 호출부(admin.routes.ts,
// services/staffAccount.ts)가 계속 "../env.js"에서 가져다 쓸 수 있도록 여기서 재수출한다.
export {
  validatePasswordPolicy,
  minPasswordLength,
  MIN_ADMIN_PASSWORD_LENGTH,
  MIN_STAFF_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "./auth/passwordPolicy.js";
export type { PasswordPolicyContext } from "./auth/passwordPolicy.js";

// ---------------------------------------------------------------------------
// production 기동 전 필수 검증 (요구사항2.md §7.3)
//
// 여기서 던지는 오류 메시지에는 실제 secret 값을 절대 포함하지 않는다 — 어떤 환경변수가
// 왜 부적합한지만 알려준다.
// ---------------------------------------------------------------------------

const MIN_PRODUCTION_SECRET_LENGTH = 32;

function assertStrongSecret(name: string, value: string | undefined, errors: string[]) {
  if (!value || value.trim().length === 0) {
    errors.push(`${name}가 설정되어 있지 않습니다.`);
    return;
  }
  if (isForbiddenValue(value)) {
    errors.push(`${name}에 기본 placeholder 값을 쓸 수 없습니다.`);
    return;
  }
  if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
    errors.push(`${name}는 최소 ${MIN_PRODUCTION_SECRET_LENGTH}자 이상이어야 합니다.`);
  }
}

/**
 * production 기동 시 1회 호출한다. 문제가 있으면 서버를 띄우지 않고 종료시킨다.
 * 개발/테스트에서는 아무 것도 하지 않는다.
 *
 * 검사 대상 계정은 ADMINID/ADMINPASSWORD 하나뿐이다 — 나머지 직원 계정은 환경변수가 아니라
 * 관리자 화면에서 만들어지고, 그때 같은 비밀번호 정책이 API 레벨에서 적용된다.
 */
export function assertProductionEnv(): void {
  if (!isProduction) return;

  const errors: string[] = [];

  assertStrongSecret("SESSION_SECRET", env.SESSION_SECRET, errors);
  assertStrongSecret("AUDIT_HMAC_KEY", env.AUDIT_HMAC_KEY, errors);
  assertStrongSecret("MFA_ENCRYPTION_KEY", env.MFA_ENCRYPTION_KEY, errors);

  const problem = validatePasswordPolicy(env.ADMINPASSWORD, { username: env.ADMINID, role: "ADMIN" });
  if (problem) errors.push(`ADMINPASSWORD: ${problem}`);
  if (env.ADMINPASSWORD === env.SESSION_SECRET) {
    errors.push("ADMINPASSWORD를 SESSION_SECRET과 같은 값으로 쓸 수 없습니다.");
  }

  if (errors.length > 0) {
    throw new Error(
      [
        "production 환경변수 검증에 실패했습니다. 아래 항목을 수정한 뒤 다시 기동하세요:",
        ...errors.map((e) => `  - ${e}`),
        "  (강한 랜덤값 생성 예: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\")",
      ].join("\n"),
    );
  }
}

/**
 * 감사 로그 HMAC 키. production에서는 AUDIT_HMAC_KEY가 반드시 존재한다(assertProductionEnv에서 보장).
 * 개발/테스트에서는 SESSION_SECRET에서 파생시켜 별도 설정 없이도 동작하게 한다.
 */
export function auditHmacKey(): Buffer {
  if (env.AUDIT_HMAC_KEY) return Buffer.from(env.AUDIT_HMAC_KEY, "utf8");
  return createHash("sha256").update(`boardbite:audit:${env.SESSION_SECRET}`).digest();
}

/** TOTP secret 봉인용 32byte 키. */
export function mfaEncryptionKey(): Buffer {
  const source = env.MFA_ENCRYPTION_KEY ?? `boardbite:mfa:${env.SESSION_SECRET}`;
  return createHash("sha256").update(source).digest();
}

/** 손님 join code HMAC 키 — 6자리 저엔트로피 값이므로 서버 키 없이는 대조표를 만들 수 없게 한다. */
export function joinCodeHmacKey(): Buffer {
  const source = env.AUDIT_HMAC_KEY ?? env.SESSION_SECRET;
  return createHash("sha256").update(`boardbite:joincode:${source}`).digest();
}
