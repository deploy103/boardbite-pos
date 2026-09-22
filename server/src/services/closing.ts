import { prisma } from "../prisma.js";
import { recordAuditLog } from "./auditLog.js";
import { computeBill } from "./billing.js";
import { computeRevenueSummary, type RevenueByMethod } from "./reporting.js";
import { listCounterSales } from "./counterSale.js";

export class ClosingError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

/** 마감 화면이 그대로 그릴 수 있는 형태의 집계(요구사항2.md §9.1). */
export interface ClosingPreview {
  openedAt: Date;
  closedAt: Date;
  /** 취소/거부를 제외한 주문 합계 — "얼마어치를 팔았나". */
  totalOrderAmount: number;
  /** 실제로 수납된 금액(VOID/REFUND 차감 후). */
  totalRevenue: number;
  totalDiscount: number;
  totalVoid: number;
  totalRefund: number;
  byMethod: RevenueByMethod[];
  /** 현금 결제수단 매출 합계 = 금고에 있어야 할 금액. */
  expectedCash: number;
  cancelledOrderCount: number;
  rejectedOrderCount: number;
  /** 아직 열려 있거나 미수금이 남은 테이블 — 마감 전에 정리해야 한다. */
  unsettledTables: { tableId: string; tableNumber: number; status: string; remainingAmount: number }[];
  forceClosedSessions: { tableSessionId: string; tableNumber: number; closedAt: Date | null; reason: string | null }[];

  // ---- FRONT 현장 결제 / 쿠폰 (요구사항.md §7) ----
  /** 일반 할인(직원 수동 입력). 쿠폰 할인과 분리해 표시한다. */
  manualDiscount: number;
  /** 쿠폰 할인 = 무료 제공액. 현금 예상액과 매출 어디에도 들어가지 않는다. */
  couponDiscount: number;
  /** 테이블/현장 순매출 구분. 현장 판매를 테이블 0번으로 표시하지 않는다. */
  byChannel: { table: number; counter: number };
  /** 메뉴에 배분된 수납 + 배분 근거 없는 수납(기존 게임 이용료 등) = 순매출 검산용. */
  menuPaidRevenue: number;
  unallocatedCharged: number;
  counterSale: { completedCount: number; cancelledCount: number };
  coupon: { redeemedCount: number; cancelledCount: number; amountCouponDiscount: number; itemCouponDiscount: number };
  /** 아직 손님이 받아가지 않았거나 환불이 필요한 현장 거래 — 마감 전에 정리해야 한다. */
  openCounterSales: { id: string; saleNo: number; pickupPending: boolean; refundNeeded: boolean; netChargedAmount: number }[];
}

/**
 * 마감 구간의 시작점. 직전 마감이 있으면 그 시각부터, 없으면 가장 오래된 결제 시각부터 집계한다.
 * 같은 구간을 두 번 세지 않도록 항상 "직전 마감 이후"를 기준으로 삼는 것이 핵심이다.
 */
export async function resolveClosingWindowStart(): Promise<Date> {
  const lastClosing = await prisma.closingSettlement.findFirst({ orderBy: { closedAt: "desc" } });
  if (lastClosing) return lastClosing.closedAt;

  const firstPayment = await prisma.payment.findFirst({ orderBy: { createdAt: "asc" } });
  if (firstPayment) return firstPayment.createdAt;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return startOfToday;
}

export async function computeClosingPreview(since?: Date, until?: Date): Promise<ClosingPreview> {
  const openedAt = since ?? (await resolveClosingWindowStart());
  const closedAt = until ?? new Date();

  const createdAtRange = { createdAt: { gte: openedAt, lte: closedAt } };

  const [summary, payments, orders, cashMethodCodes, openTables, forceClosed] = await Promise.all([
    computeRevenueSummary(openedAt, closedAt),
    prisma.payment.findMany({ where: createdAtRange, select: { kind: true, amount: true, method: true } }),
    prisma.order.findMany({
      where: { ...createdAtRange, status: { notIn: ["CANCELLED", "REJECTED"] } },
      include: { items: { where: { cancelledAt: null }, include: { options: true } } },
    }),
    prisma.paymentMethod.findMany({ where: { isCash: true }, select: { code: true } }),
    prisma.table.findMany({ where: { status: { in: ["OPEN", "SETTLING"] } }, orderBy: { number: "asc" } }),
    // TableSession에는 createdAt 컬럼이 없다(openedAt/closedAt만 있다) —
    // 기존 코드가 createdAtRange를 그대로 쓰는 바람에 마감 미리보기가 항상 Prisma 오류로 실패했다.
    // 강제 종료 이력은 "언제 닫혔는가"가 기준이므로 closedAt 구간으로 조회한다.
    prisma.tableSession.findMany({
      where: { closedAt: { gte: openedAt, lte: closedAt }, closeReason: "FORCE_CLOSED" },
      include: { table: { select: { number: true } } },
      orderBy: { closedAt: "desc" },
    }),
  ]);

  let totalVoid = 0;
  let totalRefund = 0;
  for (const payment of payments) {
    if (payment.kind === "VOID") totalVoid += payment.amount;
    if (payment.kind === "REFUND") totalRefund += payment.amount;
  }

  const totalOrderAmount = orders.reduce((sum, order) => {
    return (
      sum +
      order.items.reduce((lineSum, item) => {
        const optionsTotal = item.options.reduce((o, opt) => o + opt.extraPriceSnapshot, 0);
        return lineSum + (item.unitPrice + optionsTotal) * item.quantity;
      }, 0)
    );
  }, 0);

  const cashCodes = new Set(cashMethodCodes.map((m) => m.code));
  const expectedCash = summary.byMethod
    .filter((m) => cashCodes.has(m.method))
    .reduce((sum, m) => sum + m.amount, 0);

  // 열려 있는 테이블의 미수금은 아직 금고에 들어오지 않은 돈이다 — 마감 경고의 근거가 된다.
  const unsettledTables: ClosingPreview["unsettledTables"] = [];
  for (const table of openTables) {
    const session = await prisma.tableSession.findFirst({
      where: { tableId: table.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
      orderBy: { openedAt: "desc" },
    });
    const remainingAmount = session ? (await computeBill(session.id)).remainingAmount : 0;
    unsettledTables.push({
      tableId: table.id,
      tableNumber: table.number,
      status: table.status,
      remainingAmount,
    });
  }

  // 마감 전에 정리해야 할 현장 거래(미수령 / 환불 필요). 기간과 무관하게 지금 열려 있는 건을 본다.
  const openCounterSales = (await listCounterSales({ onlyOpen: true, limit: 200 })).map((sale) => ({
    id: sale.id,
    saleNo: sale.saleNo,
    pickupPending: sale.pickupPending,
    refundNeeded: sale.refundNeeded,
    netChargedAmount: sale.ledger.netChargedAmount,
  }));

  return {
    openedAt,
    closedAt,
    totalOrderAmount,
    totalRevenue: summary.totalRevenue,
    totalDiscount: summary.totalDiscount,
    totalVoid,
    totalRefund,
    byMethod: summary.byMethod,
    expectedCash,
    cancelledOrderCount: summary.cancelledOrderCount,
    rejectedOrderCount: summary.rejectedOrderCount,
    manualDiscount: summary.manualDiscount,
    couponDiscount: summary.couponDiscount,
    byChannel: summary.byChannel,
    menuPaidRevenue: summary.menuPaidRevenue,
    unallocatedCharged: summary.unallocatedCharged,
    counterSale: summary.counterSale,
    coupon: summary.coupon,
    openCounterSales,
    unsettledTables,
    forceClosedSessions: forceClosed.map((s) => ({
      tableSessionId: s.id,
      tableNumber: s.table.number,
      closedAt: s.closedAt,
      reason: s.closeReason,
    })),
  };
}

export interface CreateClosingInput {
  actualCash: number;
  closedById: string;
  note?: string;
  /** 미정산 테이블이 남았는데도 강행할 때 필요한 사유. */
  overrideReason?: string;
}

/**
 * 마감 확정. 집계 결과를 스냅샷으로 남기고, 이후에는 수정하지 않는다 —
 * 정정이 필요하면 새 마감 레코드를 추가한다(요구사항2.md §9.1).
 *
 * 미정산 테이블이 남아 있으면 사유 없이는 진행할 수 없다. 라우트에서 step-up까지 요구한다.
 */
export async function createClosingSettlement(input: CreateClosingInput) {
  const preview = await computeClosingPreview();

  const hasUnsettled = preview.unsettledTables.length > 0;
  if (hasUnsettled && !input.overrideReason) {
    throw new ClosingError(
      `아직 사용 중인 테이블이 ${preview.unsettledTables.length}곳 있어요. 정리 후 마감하거나 사유를 입력해 주세요.`,
    );
  }

  const cashDifference = input.actualCash - preview.expectedCash;

  const settlement = await prisma.closingSettlement.create({
    data: {
      openedAt: preview.openedAt,
      closedAt: preview.closedAt,
      expectedCash: preview.expectedCash,
      actualCash: input.actualCash,
      cashDifference,
      totalRevenue: preview.totalRevenue,
      totalDiscount: preview.totalDiscount,
      totalRefund: preview.totalRefund,
      totalVoid: preview.totalVoid,
      closedById: input.closedById,
      note: input.note?.slice(0, 500),
      snapshot: JSON.stringify(preview),
    },
  });

  await recordAuditLog({
    actorType: "STAFF",
    actorId: input.closedById,
    action: "BUSINESS_DAY_CLOSED",
    targetType: "ClosingSettlement",
    targetId: settlement.id,
    metadata: {
      expectedCash: preview.expectedCash,
      actualCash: input.actualCash,
      cashDifference,
      unsettledTableCount: preview.unsettledTables.length,
      overrideReason: input.overrideReason,
    },
  });

  return settlement;
}
