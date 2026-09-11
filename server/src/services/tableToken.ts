import { randomBytes } from "node:crypto";

/** 32바이트 이상 CSPRNG 기반 URL-safe 토큰. docs/adr/0004-table-token.md 참고. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
