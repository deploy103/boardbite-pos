import { prisma } from "../prisma.js";

export interface RevenueByMethod {
  method: string;
  amount: number;
}

export interface MenuSales {
  menuItemId: string;
  name: string;
  quantitySold: number;
  revenue: number;
}

export interface TableRevenue {
  tableId: string;
  tableNumber: number;
  revenue: number;
}

export interface RevenueSummary {
  /** 순수 결제 매출(현금+카드+기타 등, VOID/REFUND 반영). 할인은 제외. */
  totalRevenue: number;
  totalDiscount: number;
  byMethod: RevenueByMethod[];
  menuSales: MenuSales[];
  byTable: TableRevenue[];
  cancelledOrderCount: number;
  rejectedOrderCount: number;
  openTableCount: number;
}

/**
 * ADMIN 대시보드 매출 현황. 전부 Payment/Order 원장을 그대로 집계하며 별도 캐시 테이블을 두지 않는다
 * (docs/ARCHITECTURE.md §4의 "항상 파생 계산" 원칙을 리포팅에도 동일하게 적용).
 *
 * `since`/`until`을 주면 그 구간에 생성된 결제/주문만 집계한다(마감 리포트 등에서 사용).
 */
export async function computeRevenueSummary(since?: Date, until?: Date): Promise<RevenueSummary> {
  const createdAtRange =
    since || until
      ? {
          createdAt: {
            ...(since ? { gte: since } : {}),
            ...(until ? { lte: until } : {}),
          },
        }
      : undefined;

  const payments = await prisma.payment.findMany({
    where: createdAtRange,
  });
  const byIdInWindow = new Map(payments.map((p) => [p.id, p]));

  // VOID/REFUND가 참조하는 원본이 시간창 밖에 있을 수도 있으므로 필요한 원본만 별도 조회한다.
  const missingOriginalIds = payments
    .filter((p) => p.reversedPaymentId && !byIdInWindow.has(p.reversedPaymentId))
    .map((p) => p.reversedPaymentId!);
  const missingOriginals = missingOriginalIds.length
    ? await prisma.payment.findMany({ where: { id: { in: missingOriginalIds } } })
    : [];
  const originalKindById = new Map<string, string>([
    ...payments.map((p) => [p.id, p.kind] as const),
    ...missingOriginals.map((p) => [p.id, p.kind] as const),
  ]);

  let totalRevenue = 0;
  let totalDiscount = 0;
  const revenueByMethod = new Map<string, number>();

  for (const payment of payments) {
    if (payment.kind === "CHARGE") {
      totalRevenue += payment.amount;
      revenueByMethod.set(payment.method, (revenueByMethod.get(payment.method) ?? 0) + payment.amount);
    } else if (payment.kind === "DISCOUNT") {
      totalDiscount += payment.amount;
    } else {
      // VOID | REFUND
      const originalKind = payment.reversedPaymentId ? originalKindById.get(payment.reversedPaymentId) : undefined;
      if (originalKind === "DISCOUNT") {
        totalDiscount -= payment.amount;
      } else {
        totalRevenue -= payment.amount;
        revenueByMethod.set(payment.method, (revenueByMethod.get(payment.method) ?? 0) - payment.amount);
      }
    }
  }

  const orders = await prisma.order.findMany({
    where: createdAtRange,
    include: { items: { include: { options: true } } },
  });

  const menuSalesMap = new Map<string, MenuSales>();
  let cancelledOrderCount = 0;
  let rejectedOrderCount = 0;

  for (const order of orders) {
    if (order.status === "CANCELLED") cancelledOrderCount += 1;
    if (order.status === "REJECTED") rejectedOrderCount += 1;
    if (order.status === "CANCELLED" || order.status === "REJECTED") continue;

    for (const item of order.items) {
      const optionsTotal = item.options.reduce((sum, opt) => sum + opt.extraPriceSnapshot, 0);
      const lineRevenue = (item.unitPrice + optionsTotal) * item.quantity;
      const existing = menuSalesMap.get(item.menuItemId);
      if (existing) {
        existing.quantitySold += item.quantity;
        existing.revenue += lineRevenue;
      } else {
        menuSalesMap.set(item.menuItemId, {
          menuItemId: item.menuItemId,
          name: item.nameSnapshot,
          quantitySold: item.quantity,
          revenue: lineRevenue,
        });
      }
    }
  }

  const tableRevenueMap = new Map<string, number>();
  const tableSessionIds = [...new Set(payments.filter((p) => p.kind === "CHARGE").map((p) => p.tableSessionId))];
  if (tableSessionIds.length > 0) {
    const sessions = await prisma.tableSession.findMany({
      where: { id: { in: tableSessionIds } },
      include: { table: true },
    });
    const tableBySession = new Map(sessions.map((s) => [s.id, s.table]));
    for (const payment of payments) {
      const table = tableBySession.get(payment.tableSessionId);
      if (!table) continue;
      const delta = payment.kind === "CHARGE" ? payment.amount : payment.kind === "VOID" || payment.kind === "REFUND" ? -payment.amount : 0;
      if (delta === 0) continue;
      const original = payment.reversedPaymentId ? originalKindById.get(payment.reversedPaymentId) : undefined;
      if ((payment.kind === "VOID" || payment.kind === "REFUND") && original === "DISCOUNT") continue;
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
    totalRevenue,
    totalDiscount,
    byMethod: [...revenueByMethod.entries()].map(([method, amount]) => ({ method, amount })),
    menuSales: [...menuSalesMap.values()].sort((a, b) => b.quantitySold - a.quantitySold),
    byTable: [...tableRevenueMap.entries()]
      .map(([tableId, revenue]) => ({ tableId, tableNumber: tableNumberById.get(tableId) ?? 0, revenue }))
      .sort((a, b) => b.revenue - a.revenue),
    cancelledOrderCount,
    rejectedOrderCount,
    openTableCount,
  };
}
