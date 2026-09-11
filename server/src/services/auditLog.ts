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

/** 감사 로그 해시체인 무결성을 검증한다. 깨진 지점의 id를 반환하거나, 문제 없으면 null. */
export async function verifyAuditLogChain(): Promise<string | null> {
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  let expectedPrev = GENESIS_HASH;
  for (const log of logs) {
    if (log.prevHash !== expectedPrev) return log.id;
    const recomputed = computeHash(expectedPrev, {
      actorType: log.actorType,
      actorId: log.actorId,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    });
    if (recomputed !== log.hash) return log.id;
    expectedPrev = log.hash;
  }
  return null;
}
