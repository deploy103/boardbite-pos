import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLogBestEffort } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import { resolveOrderLines, type ResolvedOrderLine, OrderValidationError } from "./order.js";
import { allocateProportional } from "./discountAllocation.js";
import { COUPON_DISCOUNT_METHOD, computeCounterSaleLedger, type Db } from "./billing.js";
import { withWriteConflictRetry } from "./writeConflict.js";
import {
  CouponError,
  assertRedeemable,
  benefitOf,
  consumeCouponInTx,
  describeBenefit,
  findCouponByCode,
  normalizeCouponCode,
  type CouponWithBatch,
} from "./coupon.js";

/**
 * FRONT 현장 결제(요구사항.md §5, §12.1~12.2).
 *
 * 테이블을 열지 않고 카운터에서 바로 수납을 기록한다. 가짜 Table/TableSession을 만들지 않고
 * CounterSale 헤더 + 기존 Order/OrderItem/Payment 원장을 재사용한다.
 *
 * 조리/현장 제공이 섞인 장바구니는 **주문을 두 건으로 나눠** 처리한다:
 *   - KITCHEN 주문: status=NEW 로 만들어 KDS 조리 대기에 올린다.
 *   - COUNTER 주문: status=SERVED 로 즉시 확정한다(조리 대기를 만들지 않는다).
 * 덕분에 "룰렛 때문에 우동 주문 전체가 대기"하거나 "우동이 룰렛과 함께 자동 완료"되는 일이 없다.
 */

export class CounterSaleError extends Error {
  constructor(message: string, public status = 400, public code?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export interface CounterCartItemInput {
  menuItemId: string;
  quantity: number;
  optionChoiceIds: string[];
}

export interface CounterQuoteInput {
  items: CounterCartItemInput[];
  couponCode?: string | null;
  /** 상품권(ITEM)을 적용할 장바구니 행의 0-based 순번. 금액권은 사용하지 않는다. */
  couponTargetLineIndex?: number | null;
}

export interface QuoteLine {
  index: number;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  servingMode: "KITCHEN" | "COUNTER";
  options: { optionChoiceId: string; groupNameSnapshot: string; nameSnapshot: string; extraPriceSnapshot: number }[];
  lineTotal: number;
  /** 이 행에 배분된 할인액. */
  discountAmount: number;
}

export interface CounterQuote {
  lines: QuoteLine[];
  /** 할인 전 합계. */
  subtotal: number;
  discountAmount: number;
  /** 실제로 받아야 할 금액 = subtotal - discountAmount. 0원이면 무료 제공 확정이다. */
  totalAmount: number;
  coupon: {
    code: string;
    type: "AMOUNT" | "ITEM";
    benefitLabel: string;
    discountAmount: number;
    targetLineIndex: number | null;
    targetMenuItemId: string | null;
  } | null;
  hasKitchenItems: boolean;
  hasCounterItems: boolean;
  /**
   * 정규화된 장바구니·가격·혜택·직원에 결합된 해시(요구사항.md §12.2 2단계).
   * 확정 요청이 이 값을 함께 보내면, 서버는 트랜잭션 안에서 다시 계산해 비교한다 —
   * 미리보기 이후 값이 바뀌었다면 조용히 결제하지 않고 새 금액을 제시하며 거부한다.
   */
  quoteHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 같은 장바구니는 입력 순서나 옵션 순서가 달라도 같은 해시가 나오도록 정규화한다. */
function normalizeCart(input: CounterQuoteInput) {
  return {
    items: input.items.map((item) => ({
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      optionChoiceIds: [...item.optionChoiceIds].sort(),
    })),
    couponCode: input.couponCode ? input.couponCode.trim() : null,
    couponTargetLineIndex: input.couponTargetLineIndex ?? null,
  };
}

function computeQuoteHash(staffId: string, quote: Omit<CounterQuote, "quoteHash">): string {
  return sha256(
    JSON.stringify({
      staffId,
      lines: quote.lines.map((l) => ({
        menuItemId: l.menuItemId,
        name: l.name,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        servingMode: l.servingMode,
        options: l.options.map((o) => ({ id: o.optionChoiceId, price: o.extraPriceSnapshot })),
        discountAmount: l.discountAmount,
      })),
      subtotal: quote.subtotal,
      discountAmount: quote.discountAmount,
      totalAmount: quote.totalAmount,
      coupon: quote.coupon
        ? { code: quote.coupon.code, type: quote.coupon.type, discountAmount: quote.coupon.discountAmount, targetLineIndex: quote.coupon.targetLineIndex }
        : null,
    }),
  );
}

/**
 * 쿠폰 할인액 계산(요구사항.md §6.2, §7).
 *   - 금액권: min(권면 금액, 현재 주문 금액). 잔액은 소멸한다.
 *   - 상품권: 지정한 행의 **기본 단가 1개분**만 무료. 유료 옵션과 2개째부터는 정상 결제한다.
 * 할인이 0원이면 쿠폰을 소진하지 않는다 — 조용히 한 장을 태워버리지 않기 위해서다.
 */
function computeCouponDiscount(
  coupon: CouponWithBatch,
  lines: ResolvedOrderLine[],
  subtotal: number,
  targetLineIndex: number | null,
): { discount: number; targetLineIndex: number | null; targetMenuItemId: string | null } {
  const benefit = benefitOf(coupon);

  if (benefit.type === "AMOUNT") {
    const discount = Math.min(benefit.amount ?? 0, subtotal);
    if (discount <= 0) {
      throw new CouponError("이 거래에는 할인할 금액이 없어 쿠폰을 사용할 수 없어요.", 400, "COUPON_NO_EFFECT");
    }
    return { discount, targetLineIndex: null, targetMenuItemId: null };
  }

  const allowedIds = new Set(benefit.targets.map((t) => t.menuItemId));
  const candidateIndexes = lines.map((line, index) => ({ line, index })).filter(({ line }) => allowedIds.has(line.menuItemId));
  if (candidateIndexes.length === 0) {
    throw new CouponError(
      `이 상품권은 ${benefit.targets.map((t) => t.nameSnapshot).join(" 또는 ")}에만 쓸 수 있어요. 장바구니에 대상 메뉴가 없어요.`,
      400,
      "COUPON_TARGET_MISSING",
    );
  }

  const chosen =
    targetLineIndex !== null && targetLineIndex !== undefined
      ? candidateIndexes.find(({ index }) => index === targetLineIndex)
      : candidateIndexes[0];
  if (!chosen) {
    throw new CouponError("상품권을 적용할 메뉴를 다시 선택해 주세요.", 400, "COUPON_TARGET_INVALID");
  }

  // 동명 다른 메뉴에 적용되지 않도록 항상 메뉴 ID로 검증한다.
  const discount = Math.min(chosen.line.unitPrice, subtotal);
  if (discount <= 0) {
    throw new CouponError("이 거래에는 할인할 금액이 없어 쿠폰을 사용할 수 없어요.", 400, "COUPON_NO_EFFECT");
  }
  return { discount, targetLineIndex: chosen.index, targetMenuItemId: chosen.line.menuItemId };
}

/**
 * 견적 계산. **조회일 뿐 아무것도 예약/소진하지 않는다.**
 * `db`에 트랜잭션 클라이언트를 넘기면 확정 직전 재검증으로 그대로 재사용한다.
 */
export async function quoteCounterSale(
  input: CounterQuoteInput,
  staffId: string,
  db: Db = prisma,
): Promise<{ quote: CounterQuote; lines: ResolvedOrderLine[]; coupon: CouponWithBatch | null }> {
  const normalized = normalizeCart(input);
  const lines = await resolveOrderLines(normalized.items, "FRONT", db);
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);

  let coupon: CouponWithBatch | null = null;
  let discount = 0;
  let couponInfo: CounterQuote["coupon"] = null;

  if (normalized.couponCode) {
    const code = normalizeCouponCode(normalized.couponCode);
    coupon = await findCouponByCode(code, db);
    if (!coupon) throw new CouponError("존재하지 않는 쿠폰 번호예요.", 404, "COUPON_NOT_FOUND");
    assertRedeemable(coupon);
    const applied = computeCouponDiscount(coupon, lines, subtotal, normalized.couponTargetLineIndex);
    discount = applied.discount;
    couponInfo = {
      code: coupon.code,
      type: benefitOf(coupon).type,
      benefitLabel: describeBenefit(benefitOf(coupon)),
      discountAmount: applied.discount,
      targetLineIndex: applied.targetLineIndex,
      targetMenuItemId: applied.targetMenuItemId,
    };
  }

  // 할인 배분: 상품권은 지정한 행 하나에만, 금액권은 행 금액 비례로.
  const perLineDiscount = new Array(lines.length).fill(0);
  if (discount > 0) {
    if (couponInfo?.type === "ITEM" && couponInfo.targetLineIndex !== null) {
      perLineDiscount[couponInfo.targetLineIndex] = discount;
    } else {
      const allocated = allocateProportional(
        discount,
        lines.map((line, index) => ({ key: String(index), amount: line.lineTotal })),
      );
      for (const row of allocated) perLineDiscount[Number(row.key)] = row.amount;
    }
  }

  const quoteLines: QuoteLine[] = lines.map((line, index) => ({
    index,
    menuItemId: line.menuItemId,
    name: line.nameSnapshot,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    servingMode: line.servingMode,
    options: line.options,
    lineTotal: line.lineTotal,
    discountAmount: perLineDiscount[index],
  }));

  const partial: Omit<CounterQuote, "quoteHash"> = {
    lines: quoteLines,
    subtotal,
    discountAmount: discount,
    totalAmount: subtotal - discount,
    coupon: couponInfo,
    hasKitchenItems: lines.some((l) => l.servingMode === "KITCHEN"),
    hasCounterItems: lines.some((l) => l.servingMode === "COUNTER"),
  };

  return { quote: { ...partial, quoteHash: computeQuoteHash(staffId, partial) }, lines, coupon };
}

// ---------------------------------------------------------------------------
// 확정
// ---------------------------------------------------------------------------

export interface ConfirmCounterSaleInput extends CounterQuoteInput {
  idempotencyKey: string;
  /** 실제 받은 결제수단. 최종 금액이 0원이면 생략한다(0원 CHARGE를 억지로 만들지 않는다). */
  methodCode?: string | null;
  /** 현금 수납 시 받은 금액(거스름돈 계산/영수증 표시용). */
  tenderedAmount?: number | null;
  /** 직원이 화면에서 확인한 견적의 해시. 서버 재계산 결과와 다르면 확정하지 않는다. */
  expectedQuoteHash?: string | null;
  staffId: string;
}

export function scopeCounterIdempotencyKey(staffId: string, clientKey: string): string {
  return `counter:${staffId}:${clientKey}`;
}

function computeRequestHash(input: ConfirmCounterSaleInput): string {
  const normalized = normalizeCart(input);
  return sha256(
    JSON.stringify({
      ...normalized,
      methodCode: input.methodCode ?? null,
      tenderedAmount: input.tenderedAmount ?? null,
    }),
  );
}

/**
 * 현장 결제 확정(요구사항.md §12.2 4단계).
 *
 * 하나의 트랜잭션 안에서 현재 상태 재검증 → 쿠폰 조건부 소진 → 주문/옵션 스냅샷 →
 * 할인/수납 원장 → 거래 확정까지 처리한다. 하나라도 실패하면 전부 롤백되므로
 * "쿠폰만 소진되고 결제는 없는" 절반 상태가 남지 않는다.
 */
export async function confirmCounterSale(input: ConfirmCounterSaleInput) {
  const scopedKey = scopeCounterIdempotencyKey(input.staffId, input.idempotencyKey);
  const requestHash = computeRequestHash(input);

  const existing = await prisma.counterSale.findUnique({ where: { idempotencyKey: scopedKey } });
  if (existing) {
    // 같은 키 + 같은 본문 = 재전송 → 최초 결과를 그대로 돌려준다(돈을 두 번 받지 않는다).
    // 같은 키 + 다른 본문 = 명시적 충돌(요구사항.md §6.3).
    if (existing.requestHash !== requestHash) {
      throw new CounterSaleError(
        "같은 요청 번호로 다른 내용이 들어왔어요. 새 거래로 진행하거나 기존 거래를 확인해 주세요.",
        409,
        "IDEMPOTENCY_CONFLICT",
        { saleNo: existing.saleNo },
      );
    }
    return { sale: await getCounterSaleDetail(existing.id), reused: true as const };
  }

  const settings = await prisma.operationSettings.findUnique({ where: { id: 1 } });
  if (settings && !settings.paymentsEnabled) {
    throw new CounterSaleError("현재 결제 기능이 잠시 꺼져 있어요.", 403, "PAYMENTS_DISABLED");
  }
  if (settings && !settings.orderingEnabled) {
    throw new CounterSaleError("현재 주문 기능이 잠시 꺼져 있어요.", 403, "ORDERING_DISABLED");
  }

  let createdId: string;
  try {
    createdId = await withWriteConflictRetry(() =>
      prisma.$transaction(async (tx) => {
      // 트랜잭션 "안"에서 다시 잠금 상태를 확인한다 — 위 사전 검사 이후 ADMIN이 껐을 수 있다.
      const liveSettings = await tx.operationSettings.findUnique({ where: { id: 1 } });
      if (liveSettings && (!liveSettings.paymentsEnabled || !liveSettings.orderingEnabled)) {
        throw new CounterSaleError("현재 주문/결제 기능이 잠시 꺼져 있어요.", 403, "OPERATIONS_DISABLED");
      }

      // 1) 현재 DB 상태로 견적을 다시 계산한다. 가격/품절/옵션/쿠폰이 바뀌었으면 여기서 드러난다.
      const { quote, lines, coupon } = await quoteCounterSale(input, input.staffId, tx);
      if (input.expectedQuoteHash && input.expectedQuoteHash !== quote.quoteHash) {
        throw new CounterSaleError(
          "메뉴 가격이나 쿠폰 상태가 방금 바뀌었어요. 새 금액을 확인한 뒤 다시 결제해 주세요.",
          409,
          "QUOTE_STALE",
          { quote },
        );
      }

      // 2) 결제수단 검증. 0원 거래는 결제수단 없이 "무료 제공 완료"로 확정한다.
      let method: { code: string; isCash: boolean } | null = null;
      if (quote.totalAmount > 0) {
        if (!input.methodCode) throw new CounterSaleError("결제수단을 선택해 주세요.", 400, "METHOD_REQUIRED");
        const row = await tx.paymentMethod.findUnique({ where: { code: input.methodCode } });
        if (!row || !row.isActive) throw new CounterSaleError("사용할 수 없는 결제수단이에요.", 400, "METHOD_INVALID");
        method = { code: row.code, isCash: row.isCash };
        if (method.isCash) {
          const tendered = input.tenderedAmount ?? 0;
          if (tendered < quote.totalAmount) {
            throw new CounterSaleError("받은 금액이 결제 금액보다 적어요.", 400, "TENDER_INSUFFICIENT");
          }
        }
      }

      // 3) 거래 번호 채번. UNIQUE 제약이 있으므로 경합 시 P2002로 실패하고 전체가 롤백된다.
      const maxNo = await tx.counterSale.aggregate({ _max: { saleNo: true } });
      const saleNo = (maxNo._max.saleNo ?? 0) + 1;

      const sale = await tx.counterSale.create({
        data: {
          saleNo,
          status: "COMPLETED",
          createdById: input.staffId,
          idempotencyKey: scopedKey,
          requestHash,
        },
      });

      // 4) 주문 생성 — 조리/현장을 분리해 각자의 흐름을 타게 한다.
      const now = new Date();
      const createdItems: { lineIndex: number; orderItemId: string; quantity: number }[] = [];

      for (const mode of ["KITCHEN", "COUNTER"] as const) {
        const modeLines = quote.lines.filter((l) => l.servingMode === mode);
        if (modeLines.length === 0) continue;
        const order = await tx.order.create({
          data: {
            counterSaleId: sale.id,
            // 현장 제공 상품은 결제 확인이 곧 제공 확정이므로 곧바로 SERVED로 확정한다.
            status: mode === "KITCHEN" ? "NEW" : "SERVED",
            servedAt: mode === "COUNTER" ? now : null,
            idempotencyKey: `${scopedKey}:${mode}`,
          },
        });
        for (const line of modeLines) {
          const source = lines[line.index];
          const item = await tx.orderItem.create({
            data: {
              orderId: order.id,
              menuItemId: source.menuItemId,
              nameSnapshot: source.nameSnapshot,
              unitPrice: source.unitPrice,
              quantity: source.quantity,
              servingMode: source.servingMode,
              options: { create: source.options },
            },
          });
          createdItems.push({ lineIndex: line.index, orderItemId: item.id, quantity: source.quantity });
        }
      }
      const orderItemIdByLine = new Map(createdItems.map((c) => [c.lineIndex, c.orderItemId]));

      // 5) 쿠폰 소진 — 조건부 갱신이 정확히 1행을 바꾸지 못하면 전체 롤백된다.
      if (coupon && quote.coupon) {
        assertRedeemable(coupon, now);
        await consumeCouponInTx(tx, coupon.id, now);
        await tx.couponRedemption.create({
          data: {
            couponId: coupon.id,
            counterSaleId: sale.id,
            originalAmount: quote.subtotal,
            discountAmount: quote.coupon.discountAmount,
            targetOrderItemId:
              quote.coupon.targetLineIndex !== null ? orderItemIdByLine.get(quote.coupon.targetLineIndex) ?? null : null,
            targetMenuItemId: quote.coupon.targetMenuItemId,
            benefitSnapshot: JSON.stringify(benefitOf(coupon)),
            redeemedById: input.staffId,
          },
        });

        // 6) 할인 원장 — 실제 할인액은 여기 한 번만 기록하고, 행별 배분은 allocation으로 남긴다.
        await tx.payment.create({
          data: {
            counterSaleId: sale.id,
            kind: "DISCOUNT",
            method: COUPON_DISCOUNT_METHOD,
            amount: quote.coupon.discountAmount,
            reason: `쿠폰 ${coupon.code} · ${quote.coupon.benefitLabel}`,
            idempotencyKey: `${scopedKey}:coupon-discount`,
            createdById: input.staffId,
            allocations: {
              // 할인은 "결제된 수량"을 만들지 않는다 — 수량은 아래 CHARGE에서 한 번만 센다.
              create: quote.lines
                .filter((l) => l.discountAmount > 0)
                .map((l) => ({ orderItemId: orderItemIdByLine.get(l.index)!, quantity: 0, amount: l.discountAmount })),
            },
          },
        });
      }

      // 7) 실제 수납. 0원이면 결제 행을 만들지 않는다(무료 제공 완료).
      if (quote.totalAmount > 0 && method) {
        const netByLine = quote.lines.map((l) => ({ key: String(l.index), amount: l.lineTotal - l.discountAmount }));
        await tx.payment.create({
          data: {
            counterSaleId: sale.id,
            kind: "CHARGE",
            method: method.code,
            amount: quote.totalAmount,
            tenderedAmount: method.isCash ? input.tenderedAmount ?? null : null,
            changeAmount: method.isCash ? (input.tenderedAmount ?? 0) - quote.totalAmount : null,
            idempotencyKey: `${scopedKey}:charge`,
            createdById: input.staffId,
            allocations: {
              create: netByLine
                .filter((row) => row.amount > 0)
                .map((row) => ({
                  orderItemId: orderItemIdByLine.get(Number(row.key))!,
                  quantity: quote.lines[Number(row.key)].quantity,
                  amount: row.amount,
                })),
            },
          },
        });
      }

      return sale.id;
      },
      // SQLite는 connection_limit=1로 쓰기를 직렬화하므로, 두 FRONT 단말이 동시에 확정하면
      // 한쪽은 상대 트랜잭션이 끝날 때까지 기다린다. Prisma 기본값(maxWait 2초 / timeout 5초)은
      // 항목이 많은 장바구니에서 빠듯해 "돈은 받았는데 저장이 타임아웃" 상황을 만들 수 있어 넉넉히 잡는다.
      { maxWait: 10_000, timeout: 20_000 },
      ),
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // 같은 키의 다른 요청이 먼저 커밋됐다면 그 결과를 돌려준다(이중 수납 방지).
      const winner = await prisma.counterSale.findUnique({ where: { idempotencyKey: scopedKey } });
      if (winner && winner.requestHash === requestHash) {
        return { sale: await getCounterSaleDetail(winner.id), reused: true as const };
      }
      throw new CounterSaleError(
        "거래 번호가 방금 다른 결제와 겹쳤어요. 같은 요청으로 다시 시도해 주세요.",
        409,
        "SALE_NO_RACE",
      );
    }
    throw err;
  }

  const detail = await getCounterSaleDetail(createdId);

  // 커밋 이후에만 알림/감사를 남긴다(요구사항.md §6.3 — 실시간 알림은 커밋 후 전송).
  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: input.staffId,
    action: "COUNTER_SALE_COMPLETED",
    targetType: "CounterSale",
    targetId: createdId,
    metadata: {
      saleNo: detail.saleNo,
      subtotal: detail.ledger.orderAmount,
      discount: detail.ledger.discountAmount,
      charged: detail.ledger.netChargedAmount,
      couponCode: detail.coupon?.code ?? null,
    },
  });
  appEvents.emit(RealtimeEvent.CounterSaleRecorded, { counterSaleId: createdId, saleNo: detail.saleNo });
  if (detail.orders.some((o) => o.servingMode === "KITCHEN")) {
    appEvents.emit(RealtimeEvent.OrderCreated, { tableSessionId: null, counterSaleId: createdId });
  }

  return { sale: detail, reused: false as const };
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

const SALE_INCLUDE = {
  createdBy: { select: { id: true, displayName: true } },
  cancelledBy: { select: { id: true, displayName: true } },
  orders: { include: { items: { include: { options: true } } }, orderBy: { createdAt: "asc" } },
  payments: {
    include: { allocations: true, createdBy: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  },
  redemptions: { include: { coupon: { include: { batch: { include: { targets: true } } } } } },
} satisfies Prisma.CounterSaleInclude;

export async function getCounterSaleDetail(counterSaleId: string) {
  const sale = await prisma.counterSale.findUnique({ where: { id: counterSaleId }, include: SALE_INCLUDE });
  if (!sale) throw new CounterSaleError("존재하지 않는 현장 거래예요.", 404, "SALE_NOT_FOUND");
  return shapeSale(sale, await computeCounterSaleLedger(counterSaleId));
}

type SaleRow = Prisma.CounterSaleGetPayload<{ include: typeof SALE_INCLUDE }>;

function shapeSale(sale: SaleRow, ledger: Awaited<ReturnType<typeof computeCounterSaleLedger>>) {
  const redemption = sale.redemptions[0] ?? null;
  const orders = sale.orders.map((order) => ({
    id: order.id,
    status: order.status,
    /** 이 주문이 조리 대기인지 현장 즉시 제공인지 — 항목의 servingMode는 주문 단위로 동일하다. */
    servingMode: (order.items[0]?.servingMode ?? "COUNTER") as "KITCHEN" | "COUNTER",
    createdAt: order.createdAt,
    readyAt: order.readyAt,
    servedAt: order.servedAt,
    cancelReason: order.cancelReason,
    rejectReason: order.rejectReason,
    items: order.items,
  }));

  const kitchenOrders = orders.filter((o) => o.servingMode === "KITCHEN");
  /** 조리 주문이 아직 손님에게 전달되지 않았다 — FRONT 수령 완료 대상. */
  const pickupPending = kitchenOrders.some((o) => ["NEW", "ACCEPTED", "PREPARING", "READY"].includes(o.status));
  /**
   * 선결제 후 주방이 거절/취소했는데 아직 돈을 돌려주지 않은 상태(요구사항.md §5.4).
   * 자동 환불하지 않고 화면에 "환불 필요"로 드러내며, 실제 환불 기록 후에만 사라진다.
   */
  const refundNeeded = sale.status === "COMPLETED" && ledger.remainingAmount < 0;

  return {
    id: sale.id,
    saleNo: sale.saleNo,
    status: sale.status as "COMPLETED" | "CANCELLED",
    createdAt: sale.createdAt,
    createdBy: sale.createdBy,
    cancelledAt: sale.cancelledAt,
    cancelledBy: sale.cancelledBy,
    cancelReason: sale.cancelReason,
    orders,
    payments: sale.payments,
    coupon: redemption
      ? {
          code: redemption.coupon.code,
          type: redemption.coupon.batch.type as "AMOUNT" | "ITEM",
          benefitLabel: describeBenefit(benefitOf(redemption.coupon)),
          discountAmount: redemption.discountAmount,
          originalAmount: redemption.originalAmount,
          targetMenuItemId: redemption.targetMenuItemId,
          redeemedAt: redemption.redeemedAt,
          cancelledAt: redemption.cancelledAt,
        }
      : null,
    ledger,
    pickupPending,
    refundNeeded,
  };
}

export type CounterSaleDetail = Awaited<ReturnType<typeof getCounterSaleDetail>>;

export interface CounterSaleListFilter {
  saleNo?: number;
  status?: "COMPLETED" | "CANCELLED";
  since?: Date;
  until?: Date;
  limit?: number;
  /** true면 아직 수령하지 않았거나 환불이 필요한 거래만 보여준다(마감 전 정리용). */
  onlyOpen?: boolean;
}

export async function listCounterSales(filter: CounterSaleListFilter) {
  const where: Prisma.CounterSaleWhereInput = {};
  if (filter.saleNo !== undefined) where.saleNo = filter.saleNo;
  if (filter.status) where.status = filter.status;
  if (filter.since || filter.until) {
    where.createdAt = { ...(filter.since ? { gte: filter.since } : {}), ...(filter.until ? { lte: filter.until } : {}) };
  }

  const rows = await prisma.counterSale.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.limit ?? 50, 200),
    include: SALE_INCLUDE,
  });

  const shaped = await Promise.all(rows.map(async (row) => shapeSale(row, await computeCounterSaleLedger(row.id))));
  return filter.onlyOpen ? shaped.filter((s) => s.pickupPending || s.refundNeeded) : shaped;
}

/** 응답을 놓친 직원이 "내가 방금 보낸 그 결제"를 되찾기 위한 조회(요구사항.md §5.1). */
export async function findCounterSaleByIdempotencyKey(staffId: string, clientKey: string) {
  const sale = await prisma.counterSale.findUnique({
    where: { idempotencyKey: scopeCounterIdempotencyKey(staffId, clientKey) },
  });
  return sale ? getCounterSaleDetail(sale.id) : null;
}

// ---------------------------------------------------------------------------
// 수령 완료 / 취소·환불
// ---------------------------------------------------------------------------

/**
 * 조리 완료된 현장 주문을 손님이 받아갔음을 기록한다(요구사항.md §5.4).
 * 테이블 배정이나 자동 종료 로직은 전혀 실행하지 않는다 — markServed가 소유자를 보고 분기한다.
 */
export async function markCounterOrderPickedUp(orderId: string, staffId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, counterSaleId: true } });
  if (!order || !order.counterSaleId) {
    throw new CounterSaleError("현장 거래 주문이 아니에요.", 404, "ORDER_NOT_FOUND");
  }
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: "READY" },
    data: { status: "SERVED", servedAt: new Date() },
  });
  if (claimed.count !== 1) {
    const current = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    throw new CounterSaleError(
      current?.status === "SERVED" ? "이미 수령 완료 처리된 주문이에요." : "아직 조리가 끝나지 않았어요.",
      409,
      "ORDER_NOT_READY",
    );
  }
  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action: "COUNTER_ORDER_PICKED_UP",
    targetType: "Order",
    targetId: orderId,
    metadata: { counterSaleId: order.counterSaleId },
  });
  appEvents.emit(RealtimeEvent.OrderStatusChanged, {
    tableSessionId: null,
    counterSaleId: order.counterSaleId,
    orderId,
    status: "SERVED",
  });
  appEvents.emit(RealtimeEvent.CounterSaleRecorded, { counterSaleId: order.counterSaleId });
  return getCounterSaleDetail(order.counterSaleId);
}

/**
 * 현장 거래 전체 취소/환불(요구사항.md §6.4).
 *
 * 원본을 지우거나 덮어쓰지 않고 반대 원장을 추가한다:
 *   - 모든 CHARGE에 REFUND를, 쿠폰 DISCOUNT에도 REFUND를 달아 순 쿠폰 제공액이 취소분만큼 줄게 한다.
 *   - 쿠폰 자체는 사용 완료(USED)로 유지한다. 이미 제공한 서비스를 다시 쓰는 사고를 막기 위한 기본 정책이며,
 *     필요하면 ADMIN이 새 쿠폰을 발급한다.
 *   - 조리 대기 중이던 KDS 작업도 함께 취소한다.
 * 같은 거래에 재요청해도 중복 환불을 만들지 않는다.
 */
export async function cancelCounterSale(counterSaleId: string, staffId: string, reason: string) {
  if (!reason || reason.trim().length === 0) {
    throw new CounterSaleError("취소 사유를 입력해 주세요.", 400, "REASON_REQUIRED");
  }

  const before = await prisma.counterSale.findUnique({ where: { id: counterSaleId } });
  if (!before) throw new CounterSaleError("존재하지 않는 현장 거래예요.", 404, "SALE_NOT_FOUND");
  if (before.status === "CANCELLED") {
    // 이미 취소된 거래 — 중복 환불을 만들지 않고 현재 상태를 그대로 돌려준다.
    return { sale: await getCounterSaleDetail(counterSaleId), reused: true as const };
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.counterSale.updateMany({
      where: { id: counterSaleId, status: "COMPLETED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: staffId, cancelReason: reason.slice(0, 200) },
    });
    if (claimed.count !== 1) {
      throw new CounterSaleError("이미 취소된 거래예요.", 409, "ALREADY_CANCELLED");
    }

    const payments = await tx.payment.findMany({
      where: { counterSaleId, kind: { in: ["CHARGE", "DISCOUNT"] } },
      include: { allocations: true, reversals: { select: { id: true } } },
    });

    for (const payment of payments) {
      if (payment.reversals.length > 0) continue; // 이미 되돌린 결제는 건드리지 않는다.
      await tx.payment.create({
        data: {
          counterSaleId,
          kind: "REFUND",
          method: payment.method,
          amount: payment.amount,
          reversedPaymentId: payment.id,
          reason: reason.slice(0, 200),
          idempotencyKey: `counter:${counterSaleId}:refund:${payment.id}`,
          createdById: staffId,
          allocations: {
            create: payment.allocations.map((a) => ({ orderItemId: a.orderItemId, quantity: a.quantity, amount: a.amount })),
          },
        },
      });
    }

    await tx.order.updateMany({
      where: { counterSaleId, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.slice(0, 200) },
    });

    // 쿠폰 제공 실적 취소. 쿠폰 행 자체(status=USED)는 그대로 둔다.
    await tx.couponRedemption.updateMany({
      where: { counterSaleId, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });
  });

  const detail = await getCounterSaleDetail(counterSaleId);
  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action: "COUNTER_SALE_CANCELLED",
    targetType: "CounterSale",
    targetId: counterSaleId,
    metadata: { saleNo: detail.saleNo, reason, refunded: detail.ledger.refundedAmount, couponCode: detail.coupon?.code ?? null },
  });
  appEvents.emit(RealtimeEvent.CounterSaleRecorded, { counterSaleId, saleNo: detail.saleNo });
  for (const order of detail.orders) {
    appEvents.emit(RealtimeEvent.OrderStatusChanged, {
      tableSessionId: null,
      counterSaleId,
      orderId: order.id,
      status: "CANCELLED",
    });
  }

  return { sale: detail, reused: false as const };
}

export { OrderValidationError };
