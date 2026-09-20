/**
 * 직원 비밀번호 정책 — 역할(role) 하나로만 최소 길이가 결정된다.
 *
 * env.ts에 두지 않고 별도 모듈로 분리한 이유:
 *   1) prisma/seed.ts가 환경변수 스키마 전체를 파싱하지 않고도 이 정책을 재사용할 수 있어야 한다.
 *   2) 정책이 NODE_ENV에 따라 달라지지 않는다 — 개발/테스트/운영이 같은 기준을 쓴다.
 *      (과거에는 production만 15자, 그 외 8자였다. 그러면 "개발에서는 통과하던 비밀번호가
 *       배포 직전에야 거부되는" 문제가 생겨 기준을 하나로 통일했다.)
 *
 * ADMIN은 모든 운영 기능과 사용자 관리 권한을 쥐고 있어 탈취 시 피해가 가장 크므로
 * 더 긴 비밀번호 + TOTP 2단계 인증을 함께 요구한다(TOTP 강제는 requireRole.ts 담당).
 */

/** ADMIN 계정 최소 길이. TOTP와 함께 관리자 계정의 2중 방어선이다. */
export const MIN_ADMIN_PASSWORD_LENGTH = 15;

/** FRONT / POS / SERVING 등 일반 직원 계정 최소 길이. */
export const MIN_STAFF_PASSWORD_LENGTH = 10;

export const MAX_PASSWORD_LENGTH = 200;

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

export function isForbiddenValue(value: string): boolean {
  return FORBIDDEN_VALUES.has(value.trim().toLowerCase());
}

/** 역할별 최소 길이. role을 모르는 호출부는 없어야 하지만, 모르면 가장 엄격한 기준을 적용한다. */
export function minPasswordLength(role: string | undefined): number {
  return role === "ADMIN" ? MIN_ADMIN_PASSWORD_LENGTH : MIN_STAFF_PASSWORD_LENGTH;
}

export interface PasswordPolicyContext {
  /** 아이디와 동일한 비밀번호를 막기 위한 대조값. */
  username?: string;
  /** 계정 역할. ADMIN이면 15자, 그 외에는 10자가 최소 길이가 된다. */
  role?: string;
}

/**
 * 통과하면 null, 위반하면 사용자에게 그대로 보여줄 한국어 사유를 돌려준다.
 * 복잡도(대문자/특수문자) 강제는 하지 않는다 — 길이와 "뻔한 값 금지"가 실제 방어력이 높다.
 */
export function validatePasswordPolicy(password: string, ctx: PasswordPolicyContext = {}): string | null {
  const minLength = minPasswordLength(ctx.role);

  if (password.length < minLength) {
    const who = ctx.role === "ADMIN" ? "관리자 비밀번호는" : "비밀번호는";
    return `${who} 최소 ${minLength}자 이상이어야 합니다.`;
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
