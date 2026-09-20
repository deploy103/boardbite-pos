import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 4648 Base32 + RFC 6238 TOTP(HMAC-SHA1, 30초, 6자리) 최소 구현.
 *
 * otplib/speakeasy를 새로 들이지 않는 이유: 필요한 기능이 "secret 생성 / otpauth URI /
 * 6자리 검증" 세 가지뿐이고, 표준 알고리즘이 30줄 남짓이라 공급망 표면을 늘릴 이유가 없다
 * (요구사항2.md §1.12 "새 dependency는 최소화").
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("올바르지 않은 base32 문자열입니다.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20byte(160bit) 랜덤 secret — RFC 4226 권장 길이. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

const PERIOD_SECONDS = 30;
const DIGITS = 6;

function hotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function generateTotp(base32Secret: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(base32Secret), Math.floor(atMs / 1000 / PERIOD_SECONDS));
}

/**
 * 6자리 코드를 검증하고, 맞으면 그 코드가 속한 **counter(30초 슬롯 번호)** 를 돌려준다.
 * 틀리면 null. 기기 시계 오차를 감안해 앞뒤 1스텝(±30초)까지 허용한다.
 * 코드 비교는 타이밍 공격을 피하기 위해 timingSafeEqual을 사용한다.
 *
 * counter를 노출하는 이유는 재사용(replay) 방어 때문이다 — 호출부가 이 값을 계정에 기록해두고
 * "이미 쓴 슬롯 이하"는 거부하면, 한 번 노출된 코드가 남은 유효시간 동안 다시 통하지 않는다.
 */
export function verifyTotpCounter(
  base32Secret: string,
  token: string,
  atMs: number = Date.now(),
  window = 1,
): number | null {
  const normalized = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;

  let secret: Buffer;
  try {
    secret = base32Decode(base32Secret);
  } catch {
    return null;
  }

  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  const candidate = Buffer.from(normalized, "utf8");
  let matchedCounter: number | null = null;
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = Buffer.from(hotp(secret, counter + drift), "utf8");
    // 일치하더라도 루프를 계속 돌아 비교 횟수를 일정하게 유지한다.
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      matchedCounter = counter + drift;
    }
  }
  return matchedCounter;
}

/** 재사용 방어가 필요 없는 곳(설정 직후 1회 확인 등)을 위한 불리언 래퍼. */
export function verifyTotp(base32Secret: string, token: string, atMs: number = Date.now(), window = 1): boolean {
  return verifyTotpCounter(base32Secret, token, atMs, window) !== null;
}

/** 인증 앱(Google Authenticator 등)이 읽는 otpauth:// URI. secret은 로그에 남기지 않는다. */
export function buildOtpAuthUri(secret: string, accountName: string, issuer = "BoardBite POS"): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
