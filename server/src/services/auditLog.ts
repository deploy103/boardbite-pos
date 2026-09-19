import { createHash, createHmac } from "node:crypto";
import { prisma } from "../prisma.js";
import { auditHmacKey } from "../env.js";

const GENESIS_HASH = "0".repeat(64);

/** 신규 레코드는 항상 v2(HMAC)로 기록한다. v1은 과거 레코드 검증용으로만 남는다. */
export const CURRENT_HASH_VERSION = 2;

export interface AuditLogInput {
  actorType: "STAFF" | "SYSTEM";
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface HashablePayload {
  actorType: string;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata: string | null;
  createdAt: string;
}

/**
 * v1: SHA-256(canonical) — DB 쓰기 권한자가 그대로 재계산할 수 있어 변조 억지력이 없었다.
 * v2: HMAC-SHA256(AUDIT_HMAC_KEY, canonical) — 키는 DB 밖(환경변수)에만 존재하므로
 *     DB만 장악한 공격자는 체인을 다시 이어붙일 수 없다(요구사항2.md §5.2).
 */
function computeHash(prevHash: string, payload: HashablePayload, version: number): string {
  const canonical = JSON.stringify({ prevHash, ...payload });
  if (version >= 2) {
    return createHmac("sha256", auditHmacKey()).update(canonical).digest("hex");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

// 단일 Node 프로세스 내에서 감사 로그 append 순서를 직렬화한다(해시체인 분기 방지).
// docs/adr/0001-tech-stack.md의 "단일 프로세스 배포" 결정과 일관.
let appendQueue: Promise<unknown> = Promise.resolve();

export function recordAuditLog(input: AuditLogInput): Promise<void> {
  const task = appendQueue.then(async () => {
    const last = await prisma.auditLog.findFirst({
      orderBy: { createdAt: "desc" },
      select: { hash: true },
    });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const createdAt = new Date().toISOString();
    const metadataStr = input.metadata ? JSON.stringify(input.metadata) : null;

    const hash = computeHash(
      prevHash,
      {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: metadataStr,
        createdAt,
      },
      CURRENT_HASH_VERSION,
    );

    await prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: metadataStr,
        prevHash,
        hash,
        hashVersion: CURRENT_HASH_VERSION,
        createdAt: new Date(createdAt),
      },
    });
  });

  // 큐 자체는 실패해도 계속 이어지도록 감싸되, 호출자에게는 실제 결과를 반환한다.
  appendQueue = task.catch(() => undefined);
  return task;
}

/**
 * 금전/권한 핵심 작업은 감사 기록 실패가 요청 자체를 실패시키면 안 되지만(이미 커밋된
 * 비즈니스 트랜잭션을 되돌릴 수 없다), 조용히 삼켜서도 안 된다. 실패를 서버 로그로 크게
 * 남겨 운영자가 알아차릴 수 있게 한다(요구사항2.md §5.2).
 */
export async function recordAuditLogBestEffort(input: AuditLogInput): Promise<void> {
  try {
    await recordAuditLog(input);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[audit] 감사 로그 기록 실패 action=${input.action} targetId=${input.targetId ?? "-"}`, err);
  }
}

/**
 * 감사 로그 해시체인 무결성을 검증한다. 깨진 지점의 id를 반환하거나, 문제 없으면 null.
 *
 * `purgeAuditLogs()`로 정리(purge)를 하면 `AUDIT_LOG_PURGE` 레코드 자신은 절대 삭제되지 않지만,
 * 그 전후의 일반 레코드는 삭제될 수 있다. 그 결과 남아있는 체인에서 "직전에 삭제된 레코드"를
 * 가리키던 링크가 끊기는 지점이 맨 앞뿐 아니라 중간(두 정리 시점 사이)에도 생길 수 있다.
 * 이는 변조가 아니라 정상적인 정리 이력이므로, 다음 두 지점에서만 "이전 레코드와의 연결"
 * 검증을 면제한다: (1) 남아있는 첫 레코드, (2) `AUDIT_LOG_PURGE` 레코드 자신.
 * 그 외의 모든 링크는 그대로 엄격히 검증하므로 실제 변조는 여전히 탐지된다.
 *
 * 레코드별 hashVersion에 맞는 알고리즘으로 재계산하므로, HMAC 도입 이전에 쌓인 v1 레코드도
 * 그대로 검증된다(요구사항2.md §5.2 "기존 v1 SHA-256 레코드는 검증 가능하게 유지").
 */
export async function verifyAuditLogChain(): Promise<string | null> {
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  if (logs.length === 0) return null;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const isChainEntryPoint = i === 0 || log.action === "AUDIT_LOG_PURGE";
    if (!isChainEntryPoint) {
      const expectedPrev = logs[i - 1].hash;
      if (log.prevHash !== expectedPrev) return log.id;
    }
    const recomputed = computeHash(
      log.prevHash,
      {
        actorType: log.actorType,
        actorId: log.actorId,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
      },
      log.hashVersion,
    );
    if (recomputed !== log.hash) return log.id;
  }
  return null;
}

export interface PurgeResult {
  deletedCount: number;
  beforeDate: string;
}

/**
 * 지정한 날짜 이전의 감사 로그를 삭제한다. ADMIN + step-up 전용(요구사항2.md §2.5.2).
 * `AUDIT_LOG_PURGE` 자체 레코드는 절대 삭제하지 않아 "정리했다는 사실"은 영구히 남는다.
 * 삭제보다 먼저 정리 이벤트를 기록해, 삭제 작업 자체가 감사 로그에 남도록 한다.
 */
export async function purgeAuditLogs(beforeDate: Date, staffId: string): Promise<PurgeResult> {
  const deletedCount = await prisma.auditLog.count({
    where: { createdAt: { lt: beforeDate }, action: { not: "AUDIT_LOG_PURGE" } },
  });

  await recordAuditLog({
    actorType: "STAFF",
    actorId: staffId,
    action: "AUDIT_LOG_PURGE",
    metadata: { beforeDate: beforeDate.toISOString(), deletedCount },
  });

  await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: beforeDate }, action: { not: "AUDIT_LOG_PURGE" } },
  });

  return { deletedCount, beforeDate: beforeDate.toISOString() };
}
