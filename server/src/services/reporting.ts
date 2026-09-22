import { prisma } from "../prisma.js";
import { COUPON_DISCOUNT_METHOD } from "./billing.js";

export interface RevenueByMethod {
  method: string;
  amount: number;
}

export interface MenuSales {
  menuItemId: string;
  name: string;
  quantitySold: number;
  /** 정가 기준 주문액(기본단가+옵션)×수량. **매출이 아니다** — 할인 전 "얼마어치를 주문받았나"다. */
  orderAmount: number;
  /** 이 메뉴에 배분된 실제 수납액(환불 반영). 부스가 실제로 받은 돈이다. */
  paidRevenue: number;
  /** 쿠폰으로 무료 제공한 수량(상품권 대상이 된 횟수). */
  couponFreeCount: number;
}

export interface TableRevenue {
  tableId: string;
  tableNumber: number;
  revenue: number;
}

export interface RevenueSummary {
  // ---- 주문 기준(주문 시각) ----
  /** 취소/거부를 제외한 주문 정가 합계. */
  totalOrderAmount: number;
  cancelledOrderCount: number;
  rejectedOrderCount: number;
  openTableCount: number;

  // ---- 수납 기준(결제 시각) ----
  /** 실제 수납 총액(환불 전). */
  totalCharged: number;
  /** 수납을 되돌린 VOID/REFUND 합계. */
  totalRefunded: number;
  /** 순매출 = totalCharged - totalRefunded. 부스가 실제로 가진 돈이다. */
  totalRevenue: number;
  /** 직원이 수동 입력한 할인(쿠폰 제외). */
  manualDiscount: number;
  /** 쿠폰 할인 = 무료 제공액. 매출이 아니다. */
  couponDiscount: number;
  /** 총할인 = manual + coupon. 쿠폰 할인이 두 번 포함되지 않는다. */
  totalDiscount: number;

  byMethod: RevenueByMethod[];
  /** 현장(FRONT 카운터) / 테이블 순매출 구분. 현장 판매를 테이블 0번으로 표시하지 않는다. */
  byChannel: { table: number; counter: number };
  byTable: TableRevenue[];

  menuSales: MenuSales[];
  /** 메뉴에 배분된 수납 합계. */
  menuPaidRevenue: number;
  /**
   * 배분 근거가 없는 수납(금액 기반 테이블 결제, 기존 게임 시간제 이용료 등).
   * 과거 결제를 특정 메뉴에 임의로 귀속시키지 않고 별도 항목으로 드러낸다(요구사항.md §12.3).
   * 항상 menuPaidRevenue + unallocatedCharged === totalRevenue 가 성립한다.
   */
  unallocatedCharged: number;

  coupon: {
    redeemedCount: number;
    /** 거래 취소로 제공 실적이 취소된 건수. */
    cancelledCount: number;
    amountCouponDiscount: number;
    itemCouponDiscount: number;
  };
  counterSale: { completedCount: number; cancelledCount: number };
}

/**
 * ADMIN 대시보드 / 마감 / CSV가 모두 쓰는 단일 집계. Payment/Order 원장을 그대로 읽어
 * 파생 계산하며 별도 캐시 테이블을 두지 않는다(docs/ARCHITECTURE.md §4).
 *
 * 기간 필터의 의미를 두 축으로 나눠 쓴다(요구사항.md §7):
 *   - 수납/환불 축(totalCharged, totalRevenue, byMethod …): **결제 발생 시각** 기준.
 *     기간 밖 원본에 대한 환불도 환불 시각이 이 기간이면 여기에 반영된다.
 *   - 주문량 축(totalOrderAmount, menuSales.orderAmount …): **주문 시각** 기준.
 */
export async function computeRevenueSummary(since?: Date, until?: Date): Promise<RevenueSummary> {
  const createdAtRange =
    since || until
      ? { createdAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } }
      : undefined;

  const payments = await prisma.payment.findMany({ where: createdAtRange });
  const inWindow = new Map(payments.map((p) => [p.id, p]));

  // VOID/REFUND가 참조하는 원본이 기간 밖에 있을 수 있으므로 필요한 원본만 별도로 읽는다.
  const missingOriginalIds = payments
    .filter((p) => p.reversedPaymentId && !inWindow.has(p.reversedPaymentId))
    .map((p) => p.reversedPaymentId!);
  const missingOriginals = missingOriginalIds.length
    ? await prisma.payment.findMany({ where: { id: { in: missingOriginalIds } } })
    : [];
  const originalById = new Map([
    ...payments.map((p) => [p.id, p] as const),
    ...missingOriginals.map((p) => [p.id, p] as const),
  ]);

  let totalCharged = 0;
  let totalRefunded = 0;
  let manualDiscount = 0;
  let couponDiscount = 0;
  const revenueByMethod = new Map<string, number>();
  const channelRevenue = { table: 0, counter: 0 };

  const addChannel = (payment: { counterSaleId: string | null }, delta: number) => {
    if (payment.counterSaleId) channelRevenue.counter += delta;
    else channelRevenue.table += delta;
  };

  for (const payment of payments) {
    if (payment.kind === "CHARGE") {
      totalCharged += payment.amount;
      revenueByMethod.set(payment.method, (revenueByMethod.get(payment.method) ?? 0) + payment.amount);
      addChannel(payment, payment.amount);
      continue;
    }
    if (payment.kind === "DISCOUNT") {
      if (payment.method === COUPON_DISCOUNT_METHOD) couponDiscount += payment.amount;
      else manualDiscount += payment.amount;
      continue;
    }
    // VOID | REFUND
    const original = payment.reversedPaymentId ? originalById.get(payment.reversedPaymentId) : undefined;
    if (original?.kind === "DISCOUNT") {
      if (original.method === COUPON_DISCOUNT_METHOD) couponDiscount -= payment.amount;
      else manualDiscount -= payment.amount;
      continue;
    }
    totalRefunded += payment.amount;
    revenueByMethod.set(payment.method, (revenueByMethod.get(payment.method) ?? 0) - payment.amount);
    addChannel(payment, -payment.amount);
  }

  const totalRevenue = totalCharged - totalRefunded;

  // ---- 주문량 축 ----
  const orders = await prisma.order.findMany({
    where: createdAtRange,
    // 항목 단위 취소분은 판매되지 않았으므로 주문량/주문액에서 뺀다.
    include: { items: { where: { cancelledAt: null }, include: { options: true } } },
  });

  const menuSalesMap = new Map<string, MenuSales>();
  let cancelledOrderCount = 0;
  let rejectedOrderCount = 0;
  let totalOrderAmount = 0;

  const ensureMenuRow = (menuItemId: string, name: string): MenuSales => {
    let row = menuSalesMap.get(menuItemId);
    if (!row) {
      row = { menuItemId, name, quantitySold: 0, orderAmount: 0, paidRevenue: 0, couponFreeCount: 0 };
      menuSalesMap.set(menuItemId, row);
    }
    return row;
  };

  for (const order of orders) {
    if (order.status === "CANCELLED") cancelledOrderCount += 1;
    if (order.status === "REJECTED") rejectedOrderCount += 1;
    if (order.status === "CANCELLED" || order.status === "REJECTED") continue;

    for (const item of order.items) {
      const optionsTotal = item.options.reduce((sum, opt) => sum + opt.extraPriceSnapshot, 0);
      const lineAmount = (item.unitPrice + optionsTotal) * item.quantity;
      totalOrderAmount += lineAmount;
      const row = ensureMenuRow(item.menuItemId, item.nameSnapshot);
      row.quantitySold += item.quantity;
      row.orderAmount += lineAmount;
    }
  }

  // ---- 메뉴별 실제 수납 배분(수납 시각 기준) ----
  // PaymentAllocation은 현장 결제가 항상 남기고, 기존 테이블 "상품별 결제"도 남긴다.
  // 금액 기반 테이블 결제와 게임 시간제 이용료는 배분 근거가 없으므로 unallocated로 따로 표시한다.
  const allocations = await prisma.paymentAllocation.findMany({
    where: { payment: createdAtRange ?? {} },
    include: {
      payment: { select: { kind: true, method: true, reversedPaymentId: true } },
      orderItem: { select: { menuItemId: true, nameSnapshot: true } },
    },
  });

  let menuPaidRevenue = 0;
  for (const allocation of allocations) {
    const { payment } = allocation;
    // 할인 배분은 수납이 아니다 — 매출에 더하지 않는다.
    if (payment.kind === "DISCOUNT") continue;
    if (payment.kind !== "CHARGE") {
      const original = payment.reversedPaymentId ? originalById.get(payment.reversedPaymentId) : undefined;
      if (original?.kind === "DISCOUNT") continue;
    }
    const delta = payment.kind === "CHARGE" ? allocation.amount : -allocation.amount;
    const row = ensureMenuRow(allocation.orderItem.menuItemId, allocation.orderItem.nameSnapshot);
    row.paidRevenue += delta;
    menuPaidRevenue += delta;
  }

  // ---- 쿠폰 ----
  const redemptions = await prisma.couponRedemption.findMany({
    where: since || until ? { redeemedAt: { ...(since ? { gte: since } : {}), ...(until ? { lte: until } : {}) } } : undefined,
    include: { coupon: { select: { batch: { select: { type: true } } } } },
  });
  let amountCouponDiscount = 0;
  let itemCouponDiscount = 0;
  let redemptionCancelledCount = 0;
  for (const redemption of redemptions) {
    if (redemption.cancelledAt) redemptionCancelledCount += 1;
    // 취소된 제공 실적은 순 쿠폰 제공액에서 빠진다(요구사항.md §6.4).
    const effective = redemption.cancelledAt ? 0 : redemption.discountAmount;
    if (redemption.coupon.batch.type === "AMOUNT") amountCouponDiscount += effective;
    else itemCouponDiscount += effective;
    // 상품권 무료 제공 수량은 대상 메뉴 ID로 센다(CouponRedemption.targetMenuItemId).
    // 해당 메뉴 행이 아직 없으면(주문 시각이 기간 밖) 이름을 스냅샷에서 꺼내 새로 만든다.
    if (!redemption.cancelledAt && redemption.targetMenuItemId) {
      let name = redemption.targetMenuItemId;
      try {
        const benefit = JSON.parse(redemption.benefitSnapshot) as { targets?: { menuItemId: string; nameSnapshot: string }[] };
        name = benefit.targets?.find((t) => t.menuItemId === redemption.targetMenuItemId)?.nameSnapshot ?? name;
      } catch {
        // 스냅샷이 깨져 있어도 집계는 계속한다 — 이름만 ID로 대체된다.
      }
      ensureMenuRow(redemption.targetMenuItemId, name).couponFreeCount += 1;
    }
  }

  const [counterCompleted, counterCancelled] = await Promise.all([
    prisma.counterSale.count({ where: { ...(createdAtRange ?? {}), status: "COMPLETED" } }),
    prisma.counterSale.count({ where: { ...(createdAtRange ?? {}), status: "CANCELLED" } }),
  ]);

  // ---- 테이블별 매출 ----
  const tableRevenueMap = new Map<string, number>();
  const tableSessionIds = [
    ...new Set(payments.map((p) => p.tableSessionId).filter((id): id is string => Boolean(id))),
  ];
  if (tableSessionIds.length > 0) {
    const sessions = await prisma.tableSession.findMany({
      where: { id: { in: tableSessionIds } },
      include: { table: true },
    });
    const tableBySession = new Map(sessions.map((s) => [s.id, s.table]));
    for (const payment of payments) {
      if (!payment.tableSessionId) continue;
      const table = tableBySession.get(payment.tableSessionId);
      if (!table) continue;
      if (payment.kind === "DISCOUNT") continue;
      const original = payment.reversedPaymentId ? originalById.get(payment.reversedPaymentId) : undefined;
      if ((payment.kind === "VOID" || payment.kind === "REFUND") && original?.kind === "DISCOUNT") continue;
      const delta = payment.kind === "CHARGE" ? payment.amount : -payment.amount;
      tableRevenueMap.set(table.id, (tableRevenueMap.get(table.id) ?? 0) + delta);
    }
    for (const [tableId, revenue] of [...tableRevenueMap.entries()]) {
      if (revenue === 0) tableRevenueMap.delete(tableId);
    }
  }

  const tables = tableRevenueMap.size > 0 ? await prisma.table.findMany({ where: { id: { in: [...tableRevenueMap.keys()] } } }) : [];
  const tableNumberById = new Map(tables.map((t) => [t.id, t.number]));
  const openTableCount = await prisma.table.count({ where: { status: { in: ["OPEN", "SETTLING"] } } });

  return {
    totalOrderAmount,
    cancelledOrderCount,
    rejectedOrderCount,
    openTableCount,
    totalCharged,
    totalRefunded,
    totalRevenue,
    manualDiscount,
    couponDiscount,
    totalDiscount: manualDiscount + couponDiscount,
    byMethod: [...revenueByMethod.entries()].map(([method, amount]) => ({ method, amount })),
    byChannel: channelRevenue,
    byTable: [...tableRevenueMap.entries()]
      .map(([tableId, revenue]) => ({ tableId, tableNumber: tableNumberById.get(tableId) ?? 0, revenue }))
      .sort((a, b) => b.revenue - a.revenue),
    menuSales: [...menuSalesMap.values()].sort((a, b) => b.quantitySold - a.quantitySold),
    menuPaidRevenue,
    unallocatedCharged: totalRevenue - menuPaidRevenue,
    coupon: {
      redeemedCount: redemptions.length,
      cancelledCount: redemptionCancelledCount,
      amountCouponDiscount,
      itemCouponDiscount,
    },
    counterSale: { completedCount: counterCompleted, cancelledCount: counterCancelled },
  };
}
