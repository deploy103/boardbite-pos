import { prisma } from "../prisma.js";
import { recordAuditLog, recordAuditLogBestEffort } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import { computeBill } from "./billing.js";
import { ACTIVE_ORDER_STATUSES } from "../types/domain.js";
import { generateJoinCode, hashJoinCode, revokeDeviceSessionsForTableSession } from "./customerSession.js";

export class TableSessionError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

export interface OpenTableResult {
  session: Awaited<ReturnType<typeof prisma.tableSession.create>>;
  /** 평문 join code는 이 응답에서 딱 한 번만 나간다 — DB에는 HMAC만 남는다. */
  joinCode: string;
  gameEndsAt: Date | null;
}

/**
 * 테이블 열기. AVAILABLE → OPEN 전이를 트랜잭션 안에서 "조건부 updateMany"로 수행하므로
 * 동시에 두 요청이 들어와도 정확히 하나만 성공한다(요구사항2.md §3.7).
 */
export async function openTable(input: {
  tableId: string;
  openedById: string;
  guestCount?: number;
  note?: string;
  gameTimePlanId?: string;
}): Promise<OpenTableResult> {
  const table = await prisma.table.findUnique({ where: { id: input.tableId } });
  if (!table) throw new TableSessionError("존재하지 않는 테이블입니다.", 404);
  if (table.status === "DISABLED") {
    throw new TableSessionError("비활성화된 테이블은 열 수 없습니다.");
  }

  const joinCode = generateJoinCode();

  const { session, gameEndsAt } = await prisma.$transaction(async (tx) => {
    // AVAILABLE인 동안에만 OPEN으로 바꾼다. count===0이면 다른 요청이 이미 선점한 것.
    const claimed = await tx.table.updateMany({
      where: { id: table.id, status: "AVAILABLE" },
      data: { status: "OPEN" },
    });
    if (claimed.count !== 1) {
      throw new TableSessionError("빈 테이블만 열 수 있습니다.");
    }

    const created = await tx.tableSession.create({
      data: {
        tableId: table.id,
        guestCount: input.guestCount,
        note: input.note?.slice(0, 200),
        openedById: input.openedById,
        joinCodeIssuedAt: new Date(),
      },
    });

    // join code 해시는 tableSessionId로 도메인 분리하므로 id가 확정된 뒤에 채운다.
    const withCode = await tx.tableSession.update({
      where: { id: created.id },
      data: { joinCodeHash: hashJoinCode(created.id, joinCode) },
    });

    let endsAt: Date | null = null;
    if (input.gameTimePlanId) {
      const plan = await tx.gameTimePlan.findUnique({ where: { id: input.gameTimePlanId } });
      if (!plan || !plan.isActive) throw new TableSessionError("존재하지 않는 이용권입니다.", 400);
      endsAt = new Date(Date.now() + plan.minutes * 60_000);
      await tx.tableGameUsage.create({
        data: {
          tableSessionId: created.id,
          planId: plan.id,
          minutes: plan.minutes,
          price: plan.price,
          endsAt,
        },
      });
    }

    return { session: withCode, gameEndsAt: endsAt };
  });

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: input.openedById,
    action: "TABLE_OPENED",
    targetType: "Table",
    targetId: table.id,
    metadata: { tableSessionId: session.id, guestCount: input.guestCount },
  });

  appEvents.emit(RealtimeEvent.TableOpened, { tableId: table.id, tableSessionId: session.id });

  return { session, joinCode, gameEndsAt };
}

/**
 * 진행 중인 세션의 join code를 새로 발급한다(요구사항2.md §2.2).
 * 평문을 저장하지 않으므로 FRONT가 코드를 잊었을 때의 유일한 복구 수단이다.
 * 이미 입장한 손님 기기(device session)는 그대로 유지되고, 새 입장만 새 코드를 쓴다.
 */
export async function rotateJoinCode(input: { tableSessionId: string; staffId: string }): Promise<string> {
  const session = await prisma.tableSession.findUnique({ where: { id: input.tableSessionId } });
  if (!session) throw new TableSessionError("존재하지 않는 테이블 세션입니다.", 404);
  if (session.status !== "ACTIVE" && session.status !== "PAID_PENDING_SERVICE") {
    throw new TableSessionError("진행 중인 테이블 세션이 아닙니다.");
  }

  const joinCode = generateJoinCode();
  await prisma.tableSession.update({
    where: { id: session.id },
    data: { joinCodeHash: hashJoinCode(session.id, joinCode), joinCodeIssuedAt: new Date() },
  });

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: input.staffId,
    action: "TABLE_JOIN_CODE_ROTATED",
    targetType: "TableSession",
    targetId: session.id,
  });

  return joinCode;
}

export interface CloseBlocker {
  code: "REMAINING_AMOUNT" | "UNSERVED_ORDERS" | "PENDING_STAFF_CALLS";
  message: string;
  value: number;
}

function buildBlockers(remainingAmount: number, unservedCount: number, pendingCalls: number): CloseBlocker[] {
  const blockers: CloseBlocker[] = [];
  if (remainingAmount > 0) {
    blockers.push({
      code: "REMAINING_AMOUNT",
      message: `미결제 금액 ${remainingAmount.toLocaleString("ko-KR")}원이 남아 있습니다.`,
      value: remainingAmount,
    });
  } else if (remainingAmount < 0) {
    blockers.push({
      code: "REMAINING_AMOUNT",
      message: `초과 수납 ${Math.abs(remainingAmount).toLocaleString("ko-KR")}원이 있습니다. 환불 처리 후 종료해 주세요.`,
      value: remainingAmount,
    });
  }
  if (unservedCount > 0) {
    blockers.push({
      code: "UNSERVED_ORDERS",
      message: `아직 서빙되지 않은 주문이 ${unservedCount}건 있습니다.`,
      value: unservedCount,
    });
  }
  if (pendingCalls > 0) {
    blockers.push({
      code: "PENDING_STAFF_CALLS",
      message: `처리되지 않은 직원 호출이 ${pendingCalls}건 있습니다.`,
      value: pendingCalls,
    });
  }
  return blockers;
}

/** 일반 종료가 가능한지 판단한다(요구사항2.md §3.1). 막는 사유를 전부 모아 운영 문구로 돌려준다. */
export async function evaluateCloseBlockers(tableSessionId: string): Promise<CloseBlocker[]> {
  const [bill, unservedCount, pendingCalls] = await Promise.all([
    computeBill(tableSessionId),
    prisma.order.count({ where: { tableSessionId, status: { in: [...ACTIVE_ORDER_STATUSES] } } }),
    prisma.staffCallRequest.count({ where: { tableSessionId, status: { in: ["PENDING", "ACKED"] } } }),
  ]);
  return buildBlockers(bill.remainingAmount, unservedCount, pendingCalls);
}

export class TableCloseBlockedError extends TableSessionError {
  constructor(public blockers: CloseBlocker[]) {
    super(blockers.map((b) => b.message).join(" "), 409);
  }
}

interface CloseOptions {
  tableId: string;
  closedById: string;
  reason?: string;
  /** true면 미결제/미서빙이 남아 있어도 종료한다. ADMIN + step-up 경로에서만 사용한다. */
  force?: boolean;
  actorType?: "STAFF" | "SYSTEM";
}

/**
 * 테이블 종료.
 *
 * - 일반 종료(force=false): 미결제/미서빙/미처리 호출이 하나라도 있으면 409로 거부한다.
 *   검증은 트랜잭션 "밖"의 빠른 실패 + 트랜잭션 "안"의 재검증 두 번 수행한다.
 * - 강제 종료(force=true): ADMIN 전용. 사유가 필수이며 남은 금액/미서빙 주문 현황을
 *   감사 로그 metadata에 통째로 기록한다 — 삭제가 아니라 "기록이 남는 종료"다.
 */
export async function closeTable(input: CloseOptions) {
  const table = await prisma.table.findUnique({ where: { id: input.tableId } });
  if (!table) throw new TableSessionError("존재하지 않는 테이블입니다.", 404);

  const session = await prisma.tableSession.findFirst({
    where: { tableId: table.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
    orderBy: { openedAt: "desc" },
  });
  if (!session) throw new TableSessionError("이미 종료된 테이블입니다.");

  const blockers = await evaluateCloseBlockers(session.id);
  if (!input.force && blockers.length > 0) {
    throw new TableCloseBlockedError(blockers);
  }

  const closeReason = input.reason ?? (input.force ? "FORCE_CLOSED" : "NORMAL");

  const updatedSession = await prisma.$transaction(async (tx) => {
    if (!input.force) {
      // 트랜잭션 내부 재검증 — 검사와 종료 사이에 새 주문/호출이 끼어들 수 있다.
      const stillUnserved = await tx.order.count({
        where: { tableSessionId: session.id, status: { in: [...ACTIVE_ORDER_STATUSES] } },
      });
      const stillPendingCalls = await tx.staffCallRequest.count({
        where: { tableSessionId: session.id, status: { in: ["PENDING", "ACKED"] } },
      });
      const bill = await computeBill(session.id, tx);
      if (stillUnserved > 0 || stillPendingCalls > 0 || bill.remainingAmount !== 0) {
        // 트랜잭션 안에서는 같은 커넥션을 점유하고 있으므로(connection_limit=1) 바깥 prisma
        // 클라이언트를 다시 부르지 않고, 방금 tx로 읽은 값만으로 사유를 구성한다.
        throw new TableCloseBlockedError(buildBlockers(bill.remainingAmount, stillUnserved, stillPendingCalls));
      }
    }

    // ACTIVE/PAID_PENDING_SERVICE인 동안에만 CLOSED로 — 동시 종료 요청 중 하나만 성공한다.
    const closed = await tx.tableSession.updateMany({
      where: { id: session.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
      data: { status: "CLOSED", closedAt: new Date(), closeReason },
    });
    if (closed.count !== 1) {
      throw new TableSessionError("이미 종료된 테이블입니다.");
    }

    await tx.table.updateMany({
      where: { id: table.id, status: { in: ["OPEN", "SETTLING"] } },
      data: { status: "AVAILABLE" },
    });

    // 손님 기기 세션을 같은 트랜잭션에서 전부 무효화한다(요구사항2.md §2.2).
    await revokeDeviceSessionsForTableSession(session.id, tx);

    return tx.tableSession.findUniqueOrThrow({ where: { id: session.id } });
  });

  await recordAuditLogBestEffort({
    actorType: input.actorType ?? "STAFF",
    actorId: input.closedById,
    action: input.force ? "TABLE_FORCE_CLOSED" : "TABLE_CLOSED",
    targetType: "Table",
    targetId: table.id,
    metadata: {
      tableSessionId: session.id,
      reason: input.reason,
      force: Boolean(input.force),
      ...(input.force ? { blockers } : {}),
    },
  });

  appEvents.emit(RealtimeEvent.TableClosed, { tableId: table.id, tableSessionId: session.id });

  return updatedSession;
}

export async function extendGameTime(input: { tableSessionId: string; planId: string; staffId: string }) {
  const session = await prisma.tableSession.findUnique({
    where: { id: input.tableSessionId },
    include: { gameUsages: true },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new TableSessionError("진행 중인 테이블 세션이 아닙니다.");
  }
  const plan = await prisma.gameTimePlan.findUnique({ where: { id: input.planId } });
  if (!plan || !plan.isActive) throw new TableSessionError("존재하지 않는 이용권입니다.", 400);

  const latestEnd = session.gameUsages.reduce<Date | null>((max, usage) => {
    return !max || usage.endsAt > max ? usage.endsAt : max;
  }, null);
  const base = latestEnd && latestEnd > new Date() ? latestEnd : new Date();

  const usage = await prisma.tableGameUsage.create({
    data: {
      tableSessionId: session.id,
      planId: plan.id,
      minutes: plan.minutes,
      price: plan.price,
      endsAt: new Date(base.getTime() + plan.minutes * 60_000),
    },
  });

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: input.staffId,
    action: "TABLE_GAME_EXTENDED",
    targetType: "TableSession",
    targetId: session.id,
    metadata: { planId: plan.id, minutes: plan.minutes },
  });

  return usage;
}

export function currentGameEndsAt(gameUsages: { endsAt: Date }[]): Date | null {
  return gameUsages.reduce<Date | null>((max, usage) => (!max || usage.endsAt > max ? usage.endsAt : max), null);
}

export type AutoSettleOutcome = "CLOSED" | "PENDING_SERVICE" | "NO_CHANGE";

/**
 * 완납(remaining === 0) 시점마다 호출한다 — 결제 생성 직후(payment.ts), 그리고
 * PAID_PENDING_SERVICE 상태에서 마지막 미서빙 주문이 SERVED로 바뀔 때(order.ts) 호출된다.
 *
 * 요구사항.md §4.4:
 *   remaining == 0 이고 미서빙 주문이 없음 → 자동 CLOSE
 *   remaining == 0 이지만 미서빙 주문이 있음 → PAID_PENDING_SERVICE로 표시, 신규 주문만 차단
 *
 * 모든 상태 전이는 조건부 updateMany로 수행해 동시 호출에서도 중복 전이가 일어나지 않게 한다.
 */
export async function maybeAutoSettleTableSession(tableSessionId: string): Promise<AutoSettleOutcome> {
  const session = await prisma.tableSession.findUnique({ where: { id: tableSessionId } });
  if (!session || (session.status !== "ACTIVE" && session.status !== "PAID_PENDING_SERVICE")) {
    return "NO_CHANGE";
  }

  const bill = await computeBill(tableSessionId);
  if (bill.remainingAmount !== 0) {
    // 취소 등으로 다시 미수금이 생긴 경우 PAID_PENDING_SERVICE였다면 ACTIVE로 되돌린다.
    if (session.status === "PAID_PENDING_SERVICE") {
      await prisma.$transaction(async (tx) => {
        const reverted = await tx.tableSession.updateMany({
          where: { id: session.id, status: "PAID_PENDING_SERVICE" },
          data: { status: "ACTIVE" },
        });
        if (reverted.count === 1) {
          await tx.table.updateMany({ where: { id: session.tableId, status: "SETTLING" }, data: { status: "OPEN" } });
        }
      });
    }
    return "NO_CHANGE";
  }

  const unservedCount = await prisma.order.count({
    where: { tableSessionId, status: { in: [...ACTIVE_ORDER_STATUSES] } },
  });

  if (unservedCount === 0) {
    const closed = await prisma.$transaction(async (tx) => {
      const result = await tx.tableSession.updateMany({
        where: { id: session.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
        data: { status: "CLOSED", closedAt: new Date(), closeReason: "AUTO_SETTLED" },
      });
      if (result.count !== 1) return false;
      await tx.table.updateMany({
        where: { id: session.tableId, status: { in: ["OPEN", "SETTLING"] } },
        data: { status: "AVAILABLE" },
      });
      await revokeDeviceSessionsForTableSession(session.id, tx);
      return true;
    });

    if (!closed) return "NO_CHANGE";

    await recordAuditLogBestEffort({
      actorType: "SYSTEM",
      action: "TABLE_CLOSED",
      targetType: "TableSession",
      targetId: session.id,
      metadata: { reason: "AUTO_SETTLED" },
    });
    appEvents.emit(RealtimeEvent.TableClosed, { tableId: session.tableId, tableSessionId: session.id });
    return "CLOSED";
  }

  if (session.status !== "PAID_PENDING_SERVICE") {
    const moved = await prisma.$transaction(async (tx) => {
      const result = await tx.tableSession.updateMany({
        where: { id: session.id, status: "ACTIVE" },
        data: { status: "PAID_PENDING_SERVICE" },
      });
      if (result.count !== 1) return false;
      await tx.table.updateMany({ where: { id: session.tableId, status: "OPEN" }, data: { status: "SETTLING" } });
      return true;
    });
    if (moved) {
      await recordAuditLogBestEffort({
        actorType: "SYSTEM",
        action: "TABLE_PAID_PENDING_SERVICE",
        targetType: "TableSession",
        targetId: session.id,
        metadata: { unservedCount },
      });
    }
  }
  return "PENDING_SERVICE";
}

/** ADMIN 테이블 활성/비활성 토글(요구사항2.md §3.2 — 상태 머신 밖의 직접 PATCH 금지). */
export async function setTableEnabled(input: { tableId: string; enabled: boolean; staffId: string }) {
  const table = await prisma.table.findUnique({ where: { id: input.tableId } });
  if (!table) throw new TableSessionError("존재하지 않는 테이블입니다.", 404);

  if (!input.enabled) {
    const activeSession = await prisma.tableSession.findFirst({
      where: { tableId: table.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
    });
    if (activeSession) {
      throw new TableSessionError("사용 중인 테이블은 비활성화할 수 없습니다. 먼저 테이블을 종료해 주세요.");
    }
    const result = await prisma.table.updateMany({
      where: { id: table.id, status: { in: ["AVAILABLE", "DISABLED"] } },
      data: { status: "DISABLED" },
    });
    if (result.count !== 1) {
      throw new TableSessionError("사용 중인 테이블은 비활성화할 수 없습니다. 먼저 테이블을 종료해 주세요.");
    }
  } else {
    const result = await prisma.table.updateMany({
      where: { id: table.id, status: "DISABLED" },
      data: { status: "AVAILABLE" },
    });
    if (result.count !== 1 && table.status !== "AVAILABLE") {
      throw new TableSessionError("비활성화된 테이블만 다시 활성화할 수 있습니다.");
    }
  }

  await recordAuditLog({
    actorType: "STAFF",
    actorId: input.staffId,
    action: input.enabled ? "TABLE_ENABLED" : "TABLE_DISABLED",
    targetType: "Table",
    targetId: table.id,
  });

  return prisma.table.findUniqueOrThrow({ where: { id: table.id } });
}
