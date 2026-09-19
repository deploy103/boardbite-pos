import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mfaEncryptionKey } from "../env.js";

/**
 * TOTP secret처럼 "서버가 다시 읽어야 하지만 DB 유출 시 그대로 쓰이면 안 되는" 값을
 * AES-256-GCM(인증된 암호화)으로 봉인한다. 요구사항2.md §2.5.1.
 *
 * 저장 형식: `v1.<iv base64url>.<authTag base64url>.<ciphertext base64url>`
 * 키는 MFA_ENCRYPTION_KEY에서 파생되며 DB에는 절대 저장하지 않는다.
 */

const VERSION = "v1";
const IV_BYTES = 12; // GCM 권장 nonce 길이

export function sealSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", mfaEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), authTag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** 복호화 실패(키 교체/변조)는 예외 대신 null을 반환해 호출부가 "MFA 재설정 필요"로 다룰 수 있게 한다. */
export function openSecret(sealed: string): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const authTag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    const decipher = createDecipheriv("aes-256-gcm", mfaEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
