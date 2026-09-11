import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma.js";

/** 일반 Prisma 싱글턴과 트랜잭션 클라이언트를 동일하게 받기 위한 타입. */
export type Db = PrismaClient | Prisma.TransactionClient;

export interface BillSummary {
  totalAmount: number;
  discountAmount: number;
  chargedAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

/**
 * 테이블 세션의 미수금을 항상 Order/Payment를 집계해 파생 계산한다.
 * "현재 상태" 컬럼을 별도로 저장하지 않는다(docs/ARCHITECTURE.md §4, docs/RESEARCH.md Agent E).
 *
 * - chargedAmount: 실제 현금/카드/기타로 받은 금액(VOID/REFUND 반영)
 * - discountAmount: 할인으로 차감된 금액(VOID/REFUND 반영)
 * - paidAmount = chargedAmount + discountAmount
 * - remainingAmount가 음수이면 초과 수납(환불 필요) 상태를 의미한다 — 별도 플래그 없이 이 값 자체가 신호다.
 *
 * `db` 인자로 트랜잭션 클라이언트를 넘기면 그 트랜잭션 내부의 최신 상태를 기준으로 계산한다
 * (docs/adr/0005-sqlite-write-concurrency.md — 결제 검증은 반드시 트랜잭션 내부에서 재계산해야 한다).
 */
export async function computeBill(tableSessionId: string, db: Db = prisma): Promise<BillSummary> {
  const orders = await db.order.findMany({
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

  const payments = await db.payment.findMany({ where: { tableSessionId } });
  const byId = new Map(payments.map((p) => [p.id, p]));

  let chargedAmount = 0;
  let discountAmount = 0;
  for (const payment of payments) {
    if (payment.kind === "CHARGE") {
      chargedAmount += payment.amount;
      continue;
    }
    if (payment.kind === "DISCOUNT") {
      discountAmount += payment.amount;
      continue;
    }
    // VOID | REFUND — 원본 결제의 종류에 따라 차감할 축을 결정한다.
    const original = payment.reversedPaymentId ? byId.get(payment.reversedPaymentId) : undefined;
    if (original?.kind === "DISCOUNT") {
      discountAmount -= payment.amount;
    } else {
      chargedAmount -= payment.amount;
    }
  }

  const paidAmount = chargedAmount + discountAmount;

  return {
    totalAmount,
    discountAmount,
    chargedAmount,
    paidAmount,
    remainingAmount: totalAmount - paidAmount,
  };
}

export interface ItemPaymentStatus {
  orderItemId: string;
  quantity: number;
  paidQuantity: number;
  remainingQuantity: number;
}

/**
 * 주문 항목별 "이미 결제된 수량"을 계산한다(상품별 분할결제 검증 및 화면 표시에 사용).
 * VOID/REFUND의 allocation은 원래 CHARGE/DISCOUNT의 allocation을 상쇄한다.
 */
export async function computeItemPaymentStatus(
  orderItemIds: string[],
  db: Db = prisma,
): Promise<Map<string, ItemPaymentStatus>> {
  if (orderItemIds.length === 0) return new Map();

  const items = await db.orderItem.findMany({ where: { id: { in: orderItemIds } } });
  const allocations = await db.paymentAllocation.findMany({
    where: { orderItemId: { in: orderItemIds } },
    include: { payment: true },
  });

  const paidByItem = new Map<string, number>();
  for (const allocation of allocations) {
    const delta =
      allocation.payment.kind === "CHARGE" || allocation.payment.kind === "DISCOUNT"
        ? allocation.quantity
        : -allocation.quantity; // VOID | REFUND
    paidByItem.set(allocation.orderItemId, (paidByItem.get(allocation.orderItemId) ?? 0) + delta);
  }

  const result = new Map<string, ItemPaymentStatus>();
  for (const item of items) {
    const paidQuantity = paidByItem.get(item.id) ?? 0;
    result.set(item.id, {
      orderItemId: item.id,
      quantity: item.quantity,
      paidQuantity,
      remainingQuantity: item.quantity - paidQuantity,
    });
  }
  return result;
}
