import { prisma } from "../prisma.js";

export interface BillSummary {
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

/**
 * 테이블 세션의 미수금을 항상 Order/Payment를 집계해 파생 계산한다.
 * "현재 상태" 컬럼을 별도로 저장하지 않는다(docs/ARCHITECTURE.md §4, docs/RESEARCH.md Agent E).
 */
export async function computeBill(tableSessionId: string): Promise<BillSummary> {
  const orders = await prisma.order.findMany({
    where: { tableSessionId, status: { not: "CANCELLED" } },
    include: { items: { include: { options: true } } },
  });

  let totalAmount = 0;
  for (const order of orders) {
    for (const item of order.items) {
      const optionsTotal = item.options.reduce((sum, opt) => sum + opt.extraPriceSnapshot, 0);
      totalAmount += (item.unitPrice + optionsTotal) * item.quantity;
    }
  }

  const payments = await prisma.payment.findMany({ where: { tableSessionId } });
  let paidAmount = 0;
  for (const payment of payments) {
    if (payment.kind === "CHARGE") paidAmount += payment.amount;
    else paidAmount -= payment.amount; // VOID | REFUND
  }

  return {
    totalAmount,
    paidAmount,
    remainingAmount: totalAmount - paidAmount,
  };
}
