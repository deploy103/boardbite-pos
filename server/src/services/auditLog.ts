import { createHash } from "node:crypto";
import { prisma } from "../prisma.js";

const GENESIS_HASH = "0".repeat(64);

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

function computeHash(prevHash: string, payload: HashablePayload): string {
  const canonical = JSON.stringify({ prevHash, ...payload });
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

    const hash = computeHash(prevHash, {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: metadataStr,
      createdAt,
    });

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
        createdAt: new Date(createdAt),
      },
    });
  });

  // 큐 자체는 실패해도 계속 이어지도록 감싸되, 호출자에게는 실제 결과를 반환한다.
  appendQueue = task.catch(() => undefined);
  return task;
}

/**
 * 감사 로그 해시체인 무결성을 검증한다. 깨진 지점의 id를 반환하거나, 문제 없으면 null.
 *
 * `purgeAuditLogs()`로 정리(purge)를 하면 `AUDIT_LOG_PURGE` 레코드 자신은 절대 삭제되지 않지만,
 * 그 전후의 일반 레코드는 삭제될 수 있다. 그 결과 남아있는 체인에서 "직전에 삭제된 레코드"를
 * 가리키던 링크가 끊기는 지점이 맨 앞뿐 아니라 중간(두 정리 시점 사이)에도 생길 수 있다.
 * 이는 변조가 아니라 정상적인 정리 이력이므로, 다음 두 지점에서만 "이전 레코드와의 연결"
 * 검증을 면제한다: (1) 남아있는 첫 레코드, (2) `AUDIT_LOG_PURGE` 레코드 자신.
 * 그 외의 모든 링크(특히 "정리 이후 새로 쌓인 일반 레코드들 사이의 연결")는 그대로 엄격히 검증하므로,
 * 실제 변조(정리 없이 몰래 레코드를 지우거나 내용을 바꾸는 것)는 여전히 탐지된다.
 *
 * 트레이드오프: 정리 시점 직전 구간은 이 검증만으로는 "정리로 인해 없어졌다"와 "몰래 지워졌다"를
 * 구분하지 못한다 — 정리 자체가 ADMIN 인증이 필요한 기능이고 그 사실이 AUDIT_LOG_PURGE 레코드로
 * 항상 남으므로 받아들이는 트레이드오프다(`docs/SECURITY.md` 참고).
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
    const recomputed = computeHash(log.prevHash, {
      actorType: log.actorType,
      actorId: log.actorId,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    });
    if (recomputed !== log.hash) return log.id;
  }
  return null;
}

export interface PurgeResult {
  deletedCount: number;
  beforeDate: string;
}

/**
 * 지정한 날짜 이전의 감사 로그를 삭제한다. ADMIN 전용, 요구사항.md §13.5 "로그 삭제".
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
