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
  // 취소(CANCELLED)와 주방 거부(REJECTED)는 **제공되지 않은 주문**이므로 청구액에서 뺀다.
  // 예전에는 REJECTED를 그대로 청구액에 넣어, 주방이 거부한 메뉴 값을 손님이 계속 미수금으로
  // 떠안고 테이블도 자동 종료되지 않았다(거부 주문은 ACTIVE_ORDER_STATUSES가 아니라 서빙 대기로도
  // 잡히지 않으므로 아무도 치울 수 없는 잔액이 된다). 현장 거래 원장(computeCounterSaleLedger)과
  // 같은 기준으로 맞춘다.
  const orders = await db.order.findMany({
    where: { tableSessionId, status: { notIn: ["CANCELLED", "REJECTED"] } },
    // 항목 단위로 취소된 것도 청구하지 않는다(요구사항 1절 — 주문 항목만 취소).
    include: { items: { where: { cancelledAt: null }, include: { options: true } } },
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

// ---------------------------------------------------------------------------
// FRONT 현장 거래 원장(요구사항.md §5, §7)
//
// 테이블 세션과 계산 규칙은 같지만 소유자 컬럼이 다르다. 합계를 별도 컬럼에 저장하지 않고
// 여기서 항상 Order/Payment를 집계해 파생 계산한다 — 중복 원장을 만들지 않기 위해서다.
// ---------------------------------------------------------------------------

export interface CounterSaleLedger {
  /** 취소되지 않은 주문의 정가 합계(기본단가+옵션추가금)×수량. */
  orderAmount: number;
  /** 순 할인액(취소/환불 반영). 쿠폰 할인과 일반 할인을 모두 포함한다. */
  discountAmount: number;
  /** 그중 쿠폰 할인(method=COUPON)만. 부스 매출에서 제외되는 "무료 제공" 금액이다. */
  couponDiscountAmount: number;
  /** 실제 수납 총액(환불 전). */
  grossChargedAmount: number;
  /** 환불/취소된 수납액. */
  refundedAmount: number;
  /** 실제 매출 = grossChargedAmount - refundedAmount. */
  netChargedAmount: number;
  /** 아직 받지 못한 금액. 현장 결제는 확정 시 0이 되고, 주문 취소가 생기면 음수(환불 필요)가 된다. */
  remainingAmount: number;
}

/** 쿠폰 할인 Payment의 method 코드. PaymentMethod 테이블의 결제수단이 아니라 할인 원장용 라벨이다. */
export const COUPON_DISCOUNT_METHOD = "COUPON";

export async function computeCounterSaleLedger(counterSaleId: string, db: Db = prisma): Promise<CounterSaleLedger> {
  // 주방이 거절(REJECTED)하거나 취소(CANCELLED)한 주문은 제공되지 않았으므로 주문액에서 뺀다.
  // 현장 거래는 선결제라, 이 경우 remainingAmount가 음수가 되어 "환불 필요"로 드러난다
  // (자동 환불은 하지 않는다 — 요구사항.md §5.4).
  const orders = await db.order.findMany({
    where: { counterSaleId, status: { notIn: ["CANCELLED", "REJECTED"] } },
    include: { items: { where: { cancelledAt: null }, include: { options: true } } },
  });

  let orderAmount = 0;
  for (const order of orders) {
    for (const item of order.items) {
      const optionsTotal = item.options.reduce((sum, opt) => sum + opt.extraPriceSnapshot, 0);
      orderAmount += (item.unitPrice + optionsTotal) * item.quantity;
    }
  }

  const payments = await db.payment.findMany({ where: { counterSaleId } });
  const byId = new Map(payments.map((p) => [p.id, p]));

  let grossChargedAmount = 0;
  let refundedAmount = 0;
  let discountAmount = 0;
  let couponDiscountAmount = 0;

  for (const payment of payments) {
    if (payment.kind === "CHARGE") {
      grossChargedAmount += payment.amount;
      continue;
    }
    if (payment.kind === "DISCOUNT") {
      discountAmount += payment.amount;
      if (payment.method === COUPON_DISCOUNT_METHOD) couponDiscountAmount += payment.amount;
      continue;
    }
    // VOID | REFUND — 원본의 종류에 따라 어느 축을 되돌리는지 결정한다.
    const original = payment.reversedPaymentId ? byId.get(payment.reversedPaymentId) : undefined;
    if (original?.kind === "DISCOUNT") {
      discountAmount -= payment.amount;
      if (original.method === COUPON_DISCOUNT_METHOD) couponDiscountAmount -= payment.amount;
    } else {
      refundedAmount += payment.amount;
    }
  }

  const netChargedAmount = grossChargedAmount - refundedAmount;
  return {
    orderAmount,
    discountAmount,
    couponDiscountAmount,
    grossChargedAmount,
    refundedAmount,
    netChargedAmount,
    remainingAmount: orderAmount - discountAmount - netChargedAmount,
  };
}
