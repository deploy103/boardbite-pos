import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLogBestEffort } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import { computeBill, computeItemPaymentStatus } from "./billing.js";
import { maybeAutoSettleTableSession, type AutoSettleOutcome } from "./tableSession.js";

export class PaymentValidationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface PaymentAllocationInput {
  orderItemId: string;
  quantity: number;
}

export type PaymentMode = "AMOUNT" | "ITEMS";

export interface CreatePaymentInput {
  tableSessionId: string;
  idempotencyKey: string;
  methodCode: string;
  mode: PaymentMode;
  amount?: number;
  tenderedAmount?: number;
  allocations?: PaymentAllocationInput[];
  payerLabel?: string;
  createdById: string;
}

type PaymentWithAllocations = Prisma.PaymentGetPayload<{ include: { allocations: true } }>;

export interface CreatePaymentResult {
  payment: PaymentWithAllocations;
  bill: Awaited<ReturnType<typeof computeBill>>;
  settlement: AutoSettleOutcome;
}

/**
 * 클라이언트가 보낸 idempotency key는 그대로 저장하지 않고 항상 테이블 세션 범위로 좁힌다
 * (요구사항2.md §3.5). 주문(order.ts)과 동일한 규칙이며, 같은 단말이 여러 테이블을 정산할 때
 * 같은 key를 재사용해도 서로 충돌하지 않는다.
 */
export function scopePaymentIdempotencyKey(tableSessionId: string, clientKey: string): string {
  return `${tableSessionId}:${clientKey}`;
}

/**
 * 결제 생성. docs/adr/0005-sqlite-write-concurrency.md의 동시성 전략을 그대로 따른다:
 * "잔액/이미 결제된 수량 조회 → 검증 → insert"를 전부 하나의 트랜잭션 안에서 수행하고,
 * connection_limit=1로 트랜잭션 간 직렬화를 보장한다. 트랜잭션 밖에서 읽은 값은
 * 오직 빠른 실패(사전 검증, UX용)에만 쓰고, 실제 insert 조건은 트랜잭션 내부에서 다시 계산한다.
 */
export async function createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  const scopedKey = scopePaymentIdempotencyKey(input.tableSessionId, input.idempotencyKey);

  const existing = await prisma.payment.findUnique({
    where: { idempotencyKey: scopedKey },
    include: { allocations: true },
  });
  if (existing) {
    const bill = await computeBill(input.tableSessionId);
    return { payment: existing, bill, settlement: "NO_CHANGE" };
  }

  const session = await prisma.tableSession.findUnique({
    where: { id: input.tableSessionId },
    include: { table: true },
  });
  if (!session) throw new PaymentValidationError("존재하지 않는 테이블 세션이에요.", 404);
  if (session.status !== "ACTIVE" && session.status !== "PAID_PENDING_SERVICE") {
    throw new PaymentValidationError("이미 종료된 테이블이에요.", 409);
  }

  const settings = await prisma.operationSettings.findUnique({ where: { id: 1 } });
  if (settings && !settings.paymentsEnabled) {
    throw new PaymentValidationError("현재 결제 기능이 잠시 꺼져 있어요.", 403);
  }
  if (session.table.paymentsLocked) {
    throw new PaymentValidationError("이 테이블은 정산이 잠겨 있어요. 관리자에게 문의해 주세요.", 403);
  }

  const method = await prisma.paymentMethod.findUnique({ where: { code: input.methodCode } });
  if (!method || !method.isActive) {
    throw new PaymentValidationError("사용할 수 없는 결제수단이에요.", 400);
  }

  try {
    const payment =
      input.mode === "ITEMS"
        ? await createItemBasedPayment(input, method, scopedKey)
        : await createAmountBasedPayment(input, method, scopedKey);
    return finalizePayment(payment, input.tableSessionId);
  } catch (err) {
    // 동시 요청 경합 — 사전 idempotency 조회(existing) 이후, 트랜잭션 진입 전에 다른 요청이 먼저
    // 같은 idempotencyKey로 커밋을 완료했을 수 있다(ADR 0005의 connection_limit=1은 트랜잭션
    // "내부"의 검증-쓰기는 직렬화하지만, 트랜잭션 "밖"의 사전 조회끼리는 서로 인터리빙될 수 있다).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.payment.findUnique({
        where: { idempotencyKey: scopedKey },
        include: { allocations: true },
      });
      if (winner) {
        const bill = await computeBill(input.tableSessionId);
        return { payment: winner, bill, settlement: "NO_CHANGE" };
      }
    }
    throw err;
  }
}

async function createAmountBasedPayment(
  input: CreatePaymentInput,
  method: Prisma.PaymentMethodGetPayload<Record<string, never>>,
  scopedKey: string,
): Promise<PaymentWithAllocations> {
  return prisma.$transaction(async (tx) => {
    await assertPaymentStillAllowed(input.tableSessionId, tx);
    const bill = await computeBill(input.tableSessionId, tx);

    let amount: number;
    let tenderedAmount: number | null = null;
    let changeAmount: number | null = null;

    if (method.isCash) {
      if (!input.tenderedAmount || input.tenderedAmount <= 0) {
        throw new PaymentValidationError("받은 금액을 입력해 주세요.");
      }
      const owed = Math.max(bill.remainingAmount, 0);
      if (owed <= 0) {
        throw new PaymentValidationError("이미 남은 금액이 없어요.");
      }
      tenderedAmount = input.tenderedAmount;
      amount = Math.min(tenderedAmount, owed);
      changeAmount = tenderedAmount - amount;
    } else {
      if (!input.amount || input.amount <= 0) {
        throw new PaymentValidationError("결제 금액을 입력해 주세요.");
      }
      if (input.amount > bill.remainingAmount) {
        throw new PaymentValidationError("남은 금액을 초과해서 결제할 수 없어요. 현금 결제만 초과 수납이 가능해요.");
      }
      amount = input.amount;
    }

    return tx.payment.create({
      data: {
        tableSessionId: input.tableSessionId,
        kind: "CHARGE",
        method: method.code,
        amount,
        tenderedAmount,
        changeAmount,
        payerLabel: input.payerLabel?.slice(0, 50),
        idempotencyKey: scopedKey,
        createdById: input.createdById,
      },
      include: { allocations: true },
    });
  });
}

/**
 * 트랜잭션 "안"에서 결제 가능 여부를 다시 확인한다(요구사항2.md §3.4).
 * 트랜잭션 밖의 사전 검증 이후에 ADMIN이 결제를 잠갔거나 테이블이 닫혔을 수 있다.
 */
async function assertPaymentStillAllowed(tableSessionId: string, tx: Prisma.TransactionClient): Promise<void> {
  const session = await tx.tableSession.findUnique({
    where: { id: tableSessionId },
    include: { table: true },
  });
  if (!session) throw new PaymentValidationError("존재하지 않는 테이블 세션이에요.", 404);
  if (session.status !== "ACTIVE" && session.status !== "PAID_PENDING_SERVICE") {
    throw new PaymentValidationError("이미 종료된 테이블이에요.", 409);
  }
  if (session.table.paymentsLocked) {
    throw new PaymentValidationError("이 테이블은 정산이 잠겨 있어요. 관리자에게 문의해 주세요.", 403);
  }
  const settings = await tx.operationSettings.findUnique({ where: { id: 1 } });
  if (settings && !settings.paymentsEnabled) {
    throw new PaymentValidationError("현재 결제 기능이 잠시 꺼져 있어요.", 403);
  }
}

async function createItemBasedPayment(
  input: CreatePaymentInput,
  method: Prisma.PaymentMethodGetPayload<Record<string, never>>,
  scopedKey: string,
): Promise<PaymentWithAllocations> {
  const allocations = input.allocations ?? [];
  if (allocations.length === 0) {
    throw new PaymentValidationError("결제할 상품을 선택해 주세요.");
  }
  for (const alloc of allocations) {
    if (!Number.isInteger(alloc.quantity) || alloc.quantity < 1) {
      throw new PaymentValidationError("수량이 올바르지 않아요.");
    }
  }

  // 같은 orderItemId를 두 줄로 쪼개 보내는 방식으로 남은 수량 검증을 우회할 수 없게 한다
  // (요구사항2.md §3.4). 각 항목은 한 결제 안에서 정확히 한 번만 등장해야 한다.
  const uniqueItemIds = new Set(allocations.map((a) => a.orderItemId));
  if (uniqueItemIds.size !== allocations.length) {
    throw new PaymentValidationError("같은 상품을 중복해서 담을 수 없어요. 수량으로 합쳐 주세요.");
  }

  return prisma.$transaction(async (tx) => {
    await assertPaymentStillAllowed(input.tableSessionId, tx);
    const orderItemIds = allocations.map((a) => a.orderItemId);
    const orderItems = await tx.orderItem.findMany({
      where: { id: { in: orderItemIds } },
      include: { options: true, order: true },
    });
    const itemMap = new Map(orderItems.map((i) => [i.id, i]));

    const missing = orderItemIds.filter((id) => !itemMap.has(id));
    if (missing.length > 0) {
      throw new PaymentValidationError("존재하지 않는 주문 항목이 포함되어 있어요.", 404);
    }
    for (const item of orderItems) {
      if (item.order.tableSessionId !== input.tableSessionId) {
        throw new PaymentValidationError("다른 테이블의 상품은 결제할 수 없어요.", 403);
      }
      if (item.order.status === "CANCELLED" || item.order.status === "REJECTED") {
        throw new PaymentValidationError("취소되었거나 거부된 주문은 결제할 수 없어요.");
      }
    }

    const paymentStatus = await computeItemPaymentStatus(orderItemIds, tx);
    const sessionBill = await computeBill(input.tableSessionId, tx);

    let amount = 0;
    const allocationRows: { orderItemId: string; quantity: number; amount: number }[] = [];
    for (const alloc of allocations) {
      const item = itemMap.get(alloc.orderItemId)!;
      const status = paymentStatus.get(alloc.orderItemId)!;
      if (alloc.quantity > status.remainingQuantity) {
        throw new PaymentValidationError(
          `${item.nameSnapshot}은(는) ${status.remainingQuantity}개만 결제할 수 있어요(이미 ${status.paidQuantity}개 결제됨).`,
          409,
        );
      }
      const optionsTotal = item.options.reduce((sum, opt) => sum + opt.extraPriceSnapshot, 0);
      const lineAmount = (item.unitPrice + optionsTotal) * alloc.quantity;
      amount += lineAmount;
      allocationRows.push({ orderItemId: alloc.orderItemId, quantity: alloc.quantity, amount: lineAmount });
    }

    // 세션 전체 잔액을 넘는 상품별 결제도 초과 수납이다(예: 이미 금액 기반으로 전액을 낸 뒤
    // 상품별 결제를 또 시도하는 경우). 남은 금액 기준으로 한 번 더 막는다.
    if (amount > Math.max(sessionBill.remainingAmount, 0)) {
      throw new PaymentValidationError("남은 금액을 초과해서 결제할 수 없어요.", 409);
    }

    let tenderedAmount: number | null = null;
    let changeAmount: number | null = null;

    if (method.isCash) {
      if (!input.tenderedAmount || input.tenderedAmount < amount) {
        throw new PaymentValidationError("받은 금액이 상품 금액보다 적어요.");
      }
      tenderedAmount = input.tenderedAmount;
      changeAmount = tenderedAmount - amount;
    }

    return tx.payment.create({
      data: {
        tableSessionId: input.tableSessionId,
        kind: "CHARGE",
        method: method.code,
        amount,
        tenderedAmount,
        changeAmount,
        payerLabel: input.payerLabel?.slice(0, 50),
        idempotencyKey: scopedKey,
        createdById: input.createdById,
        allocations: { create: allocationRows },
      },
      include: { allocations: true },
    });
  });
}

async function finalizePayment(payment: PaymentWithAllocations, tableSessionId: string): Promise<CreatePaymentResult> {
  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: payment.createdById,
    action: "PAYMENT_CREATED",
    targetType: "Payment",
    targetId: payment.id,
    metadata: { tableSessionId, method: payment.method, amount: payment.amount, kind: payment.kind },
  });

  appEvents.emit(RealtimeEvent.PaymentRecorded, { tableSessionId, paymentId: payment.id });

  const settlement = await maybeAutoSettleTableSession(tableSessionId);
  if (settlement === "CLOSED") {
    await recordAuditLogBestEffort({
      actorType: "SYSTEM",
      action: "PAYMENT_COMPLETED",
      targetType: "TableSession",
      targetId: tableSessionId,
    });
  }

  const bill = await computeBill(tableSessionId);
  return { payment, bill, settlement };
}

/**
 * 결제 취소/정정. 원본 레코드를 지우지 않고 반대 레코드를 추가한다(append-only ledger).
 * kind는 세션이 아직 진행 중이면 VOID(즉시 취소), 이미 CLOSED/EXPIRED면 REFUND(사후 환불)로 구분한다.
 */
export async function voidPayment(paymentId: string, staffId: string, reason: string): Promise<CreatePaymentResult> {
  const original = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { allocations: true, reversals: true, tableSession: true },
  });
  if (!original) throw new PaymentValidationError("존재하지 않는 결제예요.", 404);
  if (original.kind !== "CHARGE" && original.kind !== "DISCOUNT") {
    throw new PaymentValidationError("취소/환불 기록은 다시 취소할 수 없어요.");
  }
  if (original.reversals.length > 0) {
    throw new PaymentValidationError("이미 취소된 결제예요.", 409);
  }
  if (!reason || reason.trim().length === 0) {
    throw new PaymentValidationError("취소 사유를 입력해 주세요.");
  }

  const kind = original.tableSession.status === "CLOSED" || original.tableSession.status === "EXPIRED" ? "REFUND" : "VOID";
  // 역방향 레코드도 세션 범위 키를 쓴다. 원본 결제 id가 이미 전역 유일하므로 중복 취소는
  // UNIQUE 제약만으로도 막히지만, 키 형식을 일관되게 유지해 감사/조회를 단순화한다.
  const idempotencyKey = scopePaymentIdempotencyKey(original.tableSessionId, `${kind.toLowerCase()}:${original.id}`);

  const reversal = await prisma.$transaction(async (tx) => {
    const alreadyReversed = await tx.payment.findUnique({ where: { idempotencyKey }, include: { allocations: true } });
    if (alreadyReversed) return alreadyReversed;

    // 트랜잭션 안에서 "역방향 레코드가 하나도 없음"을 다시 확인한다. 세션이 중간에 CLOSED로
    // 바뀌면 VOID/REFUND로 키가 달라질 수 있어 idempotencyKey만으로는 이중 취소를 못 막는다.
    const existingReversalCount = await tx.payment.count({ where: { reversedPaymentId: original.id } });
    if (existingReversalCount > 0) {
      throw new PaymentValidationError("이미 취소된 결제예요.", 409);
    }

    return tx.payment.create({
      data: {
        tableSessionId: original.tableSessionId,
        kind,
        method: original.method,
        amount: original.amount,
        reversedPaymentId: original.id,
        reason: reason.slice(0, 200),
        idempotencyKey,
        createdById: staffId,
        allocations: {
          create: original.allocations.map((a) => ({ orderItemId: a.orderItemId, quantity: a.quantity, amount: a.amount })),
        },
      },
      include: { allocations: true },
    });
  });

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action: "PAYMENT_VOIDED",
    targetType: "Payment",
    targetId: original.id,
    metadata: { reversalId: reversal.id, reason, kind },
  });

  appEvents.emit(RealtimeEvent.PaymentRecorded, { tableSessionId: original.tableSessionId, paymentId: reversal.id });

  // 취소로 미수금이 다시 생길 수 있으므로(예: 완납 후 취소) 상태를 재평가한다.
  await maybeAutoSettleTableSession(original.tableSessionId);

  const bill = await computeBill(original.tableSessionId);
  return { payment: reversal, bill, settlement: "NO_CHANGE" };
}

export interface CreateDiscountInput {
  tableSessionId: string;
  idempotencyKey: string;
  amount: number;
  reason: string;
  createdById: string;
}

/** 할인 적용 — CHARGE와 동일하게 미수금을 줄이지만 회계상 매출로 집계하지 않는다. */
export async function createDiscount(input: CreateDiscountInput): Promise<CreatePaymentResult> {
  const scopedKey = scopePaymentIdempotencyKey(input.tableSessionId, input.idempotencyKey);
  const existing = await prisma.payment.findUnique({
    where: { idempotencyKey: scopedKey },
    include: { allocations: true },
  });
  if (existing) {
    const bill = await computeBill(input.tableSessionId);
    return { payment: existing, bill, settlement: "NO_CHANGE" };
  }

  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new PaymentValidationError("할인 금액이 올바르지 않아요.");
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new PaymentValidationError("할인 사유를 입력해 주세요.");
  }

  try {
    const payment = await prisma.$transaction(async (tx) => {
      await assertPaymentStillAllowed(input.tableSessionId, tx);
      const bill = await computeBill(input.tableSessionId, tx);
      if (input.amount > bill.remainingAmount) {
        throw new PaymentValidationError("남은 금액보다 큰 금액은 할인할 수 없어요.");
      }
      return tx.payment.create({
        data: {
          tableSessionId: input.tableSessionId,
          kind: "DISCOUNT",
          method: "DISCOUNT",
          amount: input.amount,
          reason: input.reason.slice(0, 200),
          idempotencyKey: scopedKey,
          createdById: input.createdById,
        },
        include: { allocations: true },
      });
    });

    return finalizePayment(payment, input.tableSessionId);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.payment.findUnique({ where: { idempotencyKey: scopedKey }, include: { allocations: true } });
      if (winner) {
        const bill = await computeBill(input.tableSessionId);
        return { payment: winner, bill, settlement: "NO_CHANGE" };
      }
    }
    throw err;
  }
}

/** VOID/REFUND 중 어느 쪽으로 기록될지 미리 알려준다(라우트에서 권한 정책 분기에 사용). */
export async function classifyReversal(paymentId: string): Promise<"VOID" | "REFUND" | null> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { tableSession: { select: { status: true } } },
  });
  if (!payment) return null;
  return payment.tableSession.status === "CLOSED" || payment.tableSession.status === "EXPIRED" ? "REFUND" : "VOID";
}
