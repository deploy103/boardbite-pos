import { prisma } from "../prisma.js";
import { generateToken } from "./tableToken.js";
import { recordAuditLog } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import { computeBill } from "./billing.js";

const ACTIVE_ORDER_STATUSES = ["NEW", "ACCEPTED", "PREPARING", "READY"] as const;

export class TableSessionError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

export async function openTable(input: {
  tableId: string;
  openedById: string;
  guestCount?: number;
  note?: string;
  gameTimePlanId?: string;
}) {
  const table = await prisma.table.findUnique({ where: { id: input.tableId } });
  if (!table) throw new TableSessionError("존재하지 않는 테이블입니다.", 404);
  if (table.status !== "AVAILABLE") {
    throw new TableSessionError("빈 테이블만 열 수 있습니다.");
  }

  const token = generateToken();

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.tableSession.create({
      data: {
        tableId: table.id,
        token,
        guestCount: input.guestCount,
        note: input.note?.slice(0, 200),
        openedById: input.openedById,
      },
    });

    if (input.gameTimePlanId) {
      const plan = await tx.gameTimePlan.findUnique({ where: { id: input.gameTimePlanId } });
      if (!plan || !plan.isActive) throw new TableSessionError("존재하지 않는 이용권입니다.", 400);
      await tx.tableGameUsage.create({
        data: {
          tableSessionId: created.id,
          planId: plan.id,
          minutes: plan.minutes,
          price: plan.price,
          endsAt: new Date(Date.now() + plan.minutes * 60_000),
        },
      });
    }

    await tx.table.update({ where: { id: table.id }, data: { status: "OPEN" } });
    return created;
  });

  await recordAuditLog({
    actorType: "STAFF",
    actorId: input.openedById,
    action: "TABLE_OPENED",
    targetType: "Table",
    targetId: table.id,
    metadata: { tableSessionId: session.id, guestCount: input.guestCount },
  });

  appEvents.emit(RealtimeEvent.TableOpened, { tableId: table.id, tableSessionId: session.id });

  return session;
}

export async function closeTable(input: { tableId: string; closedById: string; reason?: string; force?: boolean }) {
  const table = await prisma.table.findUnique({ where: { id: input.tableId } });
  if (!table) throw new TableSessionError("존재하지 않는 테이블입니다.", 404);

  const session = await prisma.tableSession.findFirst({
    where: { tableId: table.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
    orderBy: { openedAt: "desc" },
  });
  if (!session) throw new TableSessionError("이미 종료된 테이블입니다.");

  const [updatedSession] = await prisma.$transaction([
    prisma.tableSession.update({
      where: { id: session.id },
      data: { status: "CLOSED", closedAt: new Date(), closeReason: input.reason ?? (input.force ? "FORCE_CLOSED" : "NORMAL") },
    }),
    prisma.table.update({ where: { id: table.id }, data: { status: "AVAILABLE" } }),
  ]);

  await recordAuditLog({
    actorType: "STAFF",
    actorId: input.closedById,
    action: "TABLE_CLOSED",
    targetType: "Table",
    targetId: table.id,
    metadata: { tableSessionId: session.id, reason: input.reason, force: Boolean(input.force) },
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

  await recordAuditLog({
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
      await prisma.tableSession.update({ where: { id: session.id }, data: { status: "ACTIVE" } });
      await prisma.table.update({ where: { id: session.tableId }, data: { status: "OPEN" } });
    }
    return "NO_CHANGE";
  }

  const unservedCount = await prisma.order.count({
    where: { tableSessionId, status: { in: [...ACTIVE_ORDER_STATUSES] } },
  });

  if (unservedCount === 0) {
    await prisma.$transaction([
      prisma.tableSession.update({
        where: { id: session.id },
        data: { status: "CLOSED", closedAt: new Date(), closeReason: "AUTO_SETTLED" },
      }),
      prisma.table.update({ where: { id: session.tableId }, data: { status: "AVAILABLE" } }),
    ]);
    await recordAuditLog({
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
    await prisma.$transaction([
      prisma.tableSession.update({ where: { id: session.id }, data: { status: "PAID_PENDING_SERVICE" } }),
      prisma.table.update({ where: { id: session.tableId }, data: { status: "SETTLING" } }),
    ]);
    await recordAuditLog({
      actorType: "SYSTEM",
      action: "TABLE_PAID_PENDING_SERVICE",
      targetType: "TableSession",
      targetId: session.id,
      metadata: { unservedCount },
    });
  }
  return "PENDING_SERVICE";
}
