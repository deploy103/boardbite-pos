import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

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

  ADMINID: z.string().min(1),
  ADMINPASSWORD: z.string().min(1),
  FRONTID: z.string().min(1),
  FRONTPW: z.string().min(1),
  POSID: z.string().min(1),
  POSPW: z.string().min(1),
  SERVING_ID: z.string().min(1),
  SERVING_PW: z.string().min(1),
});

export const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// production 기동 전 필수 검증 (요구사항2.md §7.3)
//
// 여기서 던지는 오류 메시지에는 실제 secret 값을 절대 포함하지 않는다 — 어떤 환경변수가
// 왜 부적합한지만 알려준다.
// ---------------------------------------------------------------------------

/** `change-me` 류의 대표적인 placeholder / 취약한 기본값. */
const FORBIDDEN_VALUES = new Set([
  "change-me",
  "changeme",
  "change_me",
  "password",
  "admin",
  "secret",
  "test",
  "1234",
  "12345678",
  "boardbite",
]);

export const MIN_PRODUCTION_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 200;
const MIN_PRODUCTION_SECRET_LENGTH = 32;

function isForbiddenValue(value: string): boolean {
  return FORBIDDEN_VALUES.has(value.trim().toLowerCase());
}

export interface PasswordPolicyContext {
  username?: string;
  /** production 정책을 강제할지 여부. 기본값은 현재 NODE_ENV. */
  production?: boolean;
}

/**
 * 비밀번호 정책(요구사항2.md §2.4). production은 15자 이상을 요구하고,
 * 개발/테스트 환경은 기존 8자 기준을 유지해 로컬 셋업 편의를 해치지 않는다.
 * 복잡도(대문자/특수문자) 강제는 하지 않는다 — 길이와 "뻔한 값 금지"가 실제 방어력이 높다.
 */
export function validatePasswordPolicy(password: string, ctx: PasswordPolicyContext = {}): string | null {
  const production = ctx.production ?? isProduction;
  const minLength = production ? MIN_PRODUCTION_PASSWORD_LENGTH : 8;

  if (password.length < minLength) {
    return `비밀번호는 최소 ${minLength}자 이상이어야 합니다.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `비밀번호는 최대 ${MAX_PASSWORD_LENGTH}자까지 사용할 수 있습니다.`;
  }
  if (isForbiddenValue(password)) {
    return "너무 흔하거나 기본값인 비밀번호는 사용할 수 없습니다.";
  }
  if (ctx.username && password.trim().toLowerCase() === ctx.username.trim().toLowerCase()) {
    return "아이디와 같은 비밀번호는 사용할 수 없습니다.";
  }
  return null;
}

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
 */
export function assertProductionEnv(): void {
  if (!isProduction) return;

  const errors: string[] = [];

  assertStrongSecret("SESSION_SECRET", env.SESSION_SECRET, errors);
  assertStrongSecret("AUDIT_HMAC_KEY", env.AUDIT_HMAC_KEY, errors);
  assertStrongSecret("MFA_ENCRYPTION_KEY", env.MFA_ENCRYPTION_KEY, errors);

  const accounts: { envName: string; username: string; password: string }[] = [
    { envName: "ADMINPASSWORD", username: env.ADMINID, password: env.ADMINPASSWORD },
    { envName: "FRONTPW", username: env.FRONTID, password: env.FRONTPW },
    { envName: "POSPW", username: env.POSID, password: env.POSPW },
    { envName: "SERVING_PW", username: env.SERVING_ID, password: env.SERVING_PW },
  ];

  for (const account of accounts) {
    const problem = validatePasswordPolicy(account.password, { username: account.username, production: true });
    if (problem) errors.push(`${account.envName}: ${problem}`);
    if (account.password === env.SESSION_SECRET) {
      errors.push(`${account.envName}를 SESSION_SECRET과 같은 값으로 쓸 수 없습니다.`);
    }
  }

  const distinctPasswords = new Set(accounts.map((a) => a.password));
  if (distinctPasswords.size !== accounts.length) {
    errors.push("부트스트랩 계정들이 같은 비밀번호를 재사용하고 있습니다. 역할별로 서로 다른 값을 사용하세요.");
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
