import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma.js";
import { joinCodeHmacKey } from "../env.js";
import { CUSTOMER_VISIBLE_SESSION_STATUSES } from "../types/domain.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const CUSTOMER_SESSION_COOKIE = "boardbite_customer";
/** 자정을 넘기는 장시간 행사를 감안한 여유값. 세션 CLOSE 시에는 즉시 revoke되므로 길어도 안전하다. */
export const CUSTOMER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const JOIN_CODE_LENGTH = 6;

/**
 * 이번 테이블 세션에서만 통하는 6자리 입장 코드.
 * `randomInt`(CSPRNG)를 쓰고, 읽어주기 쉬우면서도 10^6 공간을 그대로 쓴다.
 */
export function generateJoinCode(): string {
  return String(randomInt(0, 10 ** JOIN_CODE_LENGTH)).padStart(JOIN_CODE_LENGTH, "0");
}

/**
 * 6자리 코드는 엔트로피가 낮아 단순 해시로는 무지개표를 즉시 만들 수 있다.
 * 서버 키(HMAC) + tableSessionId 도메인 분리를 함께 적용해, DB만 가진 공격자가
 * 코드를 역산하거나 다른 세션에 재사용할 수 없게 한다.
 */
export function hashJoinCode(tableSessionId: string, code: string): string {
  return createHmac("sha256", joinCodeHmacKey()).update(`${tableSessionId}:${code}`).digest("hex");
}

export function joinCodeMatches(tableSessionId: string, storedHash: string | null, code: string): boolean {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, "utf8");
  const actual = Buffer.from(hashJoinCode(tableSessionId, code), "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 쿠키에 담기는 raw token(32byte CSPRNG)과 DB에 저장할 해시. raw는 DB에 절대 남기지 않는다. */
export function generateDeviceToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashDeviceToken(raw) };
}

export function hashDeviceToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function issueDeviceSession(tableSessionId: string, db: Db = prisma) {
  const { raw, hash } = generateDeviceToken();
  const deviceSession = await db.customerDeviceSession.create({
    data: {
      tableSessionId,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS),
      lastSeenAt: new Date(),
    },
  });
  return { rawToken: raw, deviceSession };
}

export interface ResolvedCustomerSession {
  deviceSessionId: string;
  tableSessionId: string;
  tableId: string;
  tableNumber: number;
  sessionStatus: "ACTIVE" | "PAID_PENDING_SERVICE";
  tableOrdersLocked: boolean;
}

/**
 * 쿠키의 raw token으로 현재 유효한 손님 세션을 찾는다.
 *
 * 유효 조건(요구사항2.md §2.2):
 *  - device session이 revoke되지 않았고 만료 전
 *  - 연결된 TableSession이 ACTIVE 또는 PAID_PENDING_SERVICE
 *  - 연결된 Table이 OPEN 또는 SETTLING
 *
 * publicSlug는 이 판정에 전혀 관여하지 않는다 — 저장해둔 /t/<slug> 링크만으로는
 * 어떤 세션에도 들어갈 수 없다.
 */
export async function resolveCustomerSession(rawToken: string): Promise<ResolvedCustomerSession | null> {
  const deviceSession = await prisma.customerDeviceSession.findUnique({
    where: { tokenHash: hashDeviceToken(rawToken) },
    include: { tableSession: { include: { table: true } } },
  });

  if (!deviceSession) return null;
  if (deviceSession.revokedAt) return null;
  if (deviceSession.expiresAt <= new Date()) return null;

  const tableSession = deviceSession.tableSession;
  const sessionOk = (CUSTOMER_VISIBLE_SESSION_STATUSES as readonly string[]).includes(tableSession.status);
  const tableOk = tableSession.table.status === "OPEN" || tableSession.table.status === "SETTLING";
  if (!sessionOk || !tableOk) return null;

  return {
    deviceSessionId: deviceSession.id,
    tableSessionId: tableSession.id,
    tableId: tableSession.tableId,
    tableNumber: tableSession.table.number,
    sessionStatus: tableSession.status as "ACTIVE" | "PAID_PENDING_SERVICE",
    tableOrdersLocked: tableSession.table.ordersLocked,
  };
}

/** 테이블 CLOSE 시 해당 세션의 모든 손님 기기를 즉시 무효화한다. */
export async function revokeDeviceSessionsForTableSession(tableSessionId: string, db: Db = prisma): Promise<number> {
  const result = await db.customerDeviceSession.updateMany({
    where: { tableSessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** 만료/revoke된 지 오래된 레코드를 지운다(요구사항2.md §4.1 자동 정리). */
export async function cleanupExpiredDeviceSessions(retentionMs = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs);
  const result = await prisma.customerDeviceSession.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
    },
  });
  return result.count;
}
