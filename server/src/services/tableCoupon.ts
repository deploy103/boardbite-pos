import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLogBestEffort } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import { COUPON_DISCOUNT_METHOD, computeBill } from "./billing.js";
import { allocateProportional } from "./discountAllocation.js";
import { maybeAutoSettleTableSession } from "./tableSession.js";
import { withWriteConflictRetry } from "./writeConflict.js";
import {
  CouponError,
  assertRedeemable,
  benefitOf,
  consumeCouponInTx,
  describeBenefit,
  findCouponByCode,
  normalizeCouponCode,
} from "./coupon.js";

/**
 * 테이블 후불 정산에서의 쿠폰 사용(요구사항.md §6).
 *
 * 현장 결제와 **같은 규칙**을 쓴다 — 거래당 1장, 금액권은 min(권면, 미수금)이며 잔액 소멸,
 * 상품권은 지정 상품 1개의 기본가만 무료(유료 옵션 별도). 다른 점은 소유자가 CounterSale이 아니라
 * TableSession이라는 것뿐이고, 할인은 기존 DISCOUNT 원장에 method=COUPON으로 한 번만 기록된다.
 *
 * 매출 집계(reporting.ts)는 method로 쿠폰 할인을 구분하므로, 테이블 쪽도 자동으로
 * "쿠폰 할인은 매출이 아니다" 규칙을 그대로 따른다.
 */

export interface TableCouponPreview {
  code: string;
  type: "AMOUNT" | "ITEM";
  benefitLabel: string;
  /** 실제로 깎이는 금액. */
  discountAmount: number;
  /** 상품권이 적용될 주문 항목(금액권은 null). */
  targetOrderItemId: string | null;
  targetMenuItemId: string | null;
  targetName: string | null;
  remainingBefore: number;
  remainingAfter: number;
  /** 상품권을 적용할 수 있는 후보 항목들 — 직원이 화면에서 고른다. */
  candidates: { orderItemId: string; name: string; unitPrice: number; quantity: number }[];
}

interface ResolveInput {
  tableSessionId: string;
  rawCode: string;
  targetOrderItemId?: string | null;
  db?: Prisma.TransactionClient | typeof prisma;
}

/**
 * 쿠폰 적용 결과를 계산한다. **상태를 바꾸지 않는다** — 미리보기와 확정이 같은 함수를 쓰므로
 * 화면에 보여준 금액과 실제 차감액이 어긋날 수 없다.
 */
async function resolveTableCoupon({ tableSessionId, rawCode, targetOrderItemId, db = prisma }: ResolveInput) {
  const code = normalizeCouponCode(rawCode);
  const coupon = await findCouponByCode(code, db);
  if (!coupon) throw new CouponError("존재하지 않는 쿠폰 번호예요.", 404, "COUPON_NOT_FOUND");
  assertRedeemable(coupon);

  // 거래당 1장 — 이미 이 세션에 살아있는 쿠폰 사용이 있으면 막는다.
  const existing = await db.couponRedemption.findFirst({ where: { tableSessionId, cancelledAt: null } });
  if (existing) {
    throw new CouponError("이 테이블에는 이미 쿠폰이 적용되어 있어요. 한 거래에 한 장만 쓸 수 있습니다.", 409, "COUPON_ALREADY_APPLIED");
  }

  const bill = await computeBill(tableSessionId, db);
  const remaining = Math.max(bill.remainingAmount, 0);
  if (remaining <= 0) {
    throw new CouponError("남은 금액이 없어 쿠폰을 사용할 수 없어요.", 400, "COUPON_NO_EFFECT");
  }

  const benefit = benefitOf(coupon);
  const orders = await db.order.findMany({
    where: { tableSessionId, status: { notIn: ["CANCELLED", "REJECTED"] } },
    include: { items: { include: { options: true } } },
    orderBy: { createdAt: "asc" },
  });
  const items = orders.flatMap((order) => order.items);

  let discount: number;
  let targetItemId: string | null = null;
  let targetMenuItemId: string | null = null;
  let targetName: string | null = null;
  let candidates: TableCouponPreview["candidates"] = [];

  if (benefit.type === "AMOUNT") {
    discount = Math.min(benefit.amount ?? 0, remaining);
  } else {
    const allowed = new Set(benefit.targets.map((t) => t.menuItemId));
    candidates = items
      .filter((item) => allowed.has(item.menuItemId))
      .map((item) => ({ orderItemId: item.id, name: item.nameSnapshot, unitPrice: item.unitPrice, quantity: item.quantity }));
    if (candidates.length === 0) {
      throw new CouponError(
        `이 상품권은 ${benefit.targets.map((t) => t.nameSnapshot).join(" 또는 ")}에만 쓸 수 있어요. 주문에 대상 메뉴가 없어요.`,
        400,
        "COUPON_TARGET_MISSING",
      );
    }
    const chosen = targetOrderItemId ? candidates.find((c) => c.orderItemId === targetOrderItemId) : candidates[0];
    if (!chosen) throw new CouponError("상품권을 적용할 메뉴를 다시 선택해 주세요.", 400, "COUPON_TARGET_INVALID");
    // 수량이 2개여도 1개 기본가만, 옵션 추가금은 제외한다.
    discount = Math.min(chosen.unitPrice, remaining);
    targetItemId = chosen.orderItemId;
    targetName = chosen.name;
    targetMenuItemId = items.find((i) => i.id === chosen.orderItemId)?.menuItemId ?? null;
  }

  if (discount <= 0) {
    throw new CouponError("이 거래에는 할인할 금액이 없어 쿠폰을 사용할 수 없어요.", 400, "COUPON_NO_EFFECT");
  }

  const preview: TableCouponPreview = {
    code: coupon.code,
    type: benefit.type,
    benefitLabel: describeBenefit(benefit),
    discountAmount: discount,
    targetOrderItemId: targetItemId,
    targetMenuItemId,
    targetName,
    remainingBefore: remaining,
    remainingAfter: remaining - discount,
    candidates,
  };
  return { coupon, benefit, preview, items, bill };
}

/** FRONT 화면이 "이 쿠폰을 쓰면 얼마가 깎이는지" 먼저 보여주기 위한 조회. 아무것도 소진하지 않는다. */
export async function previewTableCoupon(input: Omit<ResolveInput, "db">): Promise<TableCouponPreview> {
  const { preview } = await resolveTableCoupon(input);
  return preview;
}

export interface ApplyTableCouponInput {
  tableSessionId: string;
  rawCode: string;
  targetOrderItemId?: string | null;
  idempotencyKey: string;
  staffId: string;
}

/**
 * 쿠폰 확정. 하나의 트랜잭션 안에서 재검증 → 쿠폰 조건부 소진 → 할인 원장 기록까지 처리한다.
 * 같은 멱등 키 재전송은 최초 할인을 그대로 돌려주고 두 번 깎지 않는다.
 */
export async function applyTableCoupon(input: ApplyTableCouponInput) {
  const scopedKey = `${input.tableSessionId}:coupon:${input.idempotencyKey}`;

  const existing = await prisma.payment.findUnique({ where: { idempotencyKey: scopedKey } });
  if (existing) {
    return { payment: existing, bill: await computeBill(input.tableSessionId), reused: true as const };
  }

  const settings = await prisma.operationSettings.findUnique({ where: { id: 1 } });
  if (settings && !settings.paymentsEnabled) {
    throw new CouponError("현재 결제 기능이 잠시 꺼져 있어요.", 403, "PAYMENTS_DISABLED");
  }

  try {
    const payment = await withWriteConflictRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const session = await tx.tableSession.findUnique({
            where: { id: input.tableSessionId },
            include: { table: true },
          });
          if (!session) throw new CouponError("존재하지 않는 테이블 세션이에요.", 404, "SESSION_NOT_FOUND");
          if (session.status !== "ACTIVE" && session.status !== "PAID_PENDING_SERVICE") {
            throw new CouponError("이미 종료된 테이블이에요.", 409, "SESSION_CLOSED");
          }
          if (session.table.paymentsLocked) {
            throw new CouponError("이 테이블은 정산이 잠겨 있어요.", 403, "TABLE_LOCKED");
          }
          const live = await tx.operationSettings.findUnique({ where: { id: 1 } });
          if (live && !live.paymentsEnabled) {
            throw new CouponError("현재 결제 기능이 잠시 꺼져 있어요.", 403, "PAYMENTS_DISABLED");
          }

          // 트랜잭션 안에서 다시 계산한다 — 미리보기 이후 주문/결제가 바뀌었어도 여기 값이 기준이다.
          const { coupon, benefit, preview, items } = await resolveTableCoupon({
            tableSessionId: input.tableSessionId,
            rawCode: input.rawCode,
            targetOrderItemId: input.targetOrderItemId,
            db: tx,
          });

          assertRedeemable(coupon);
          await consumeCouponInTx(tx, coupon.id);

          // 행별 배분: 상품권은 지정 항목 하나에, 금액권은 항목 금액 비례로.
          let allocations: { orderItemId: string; quantity: number; amount: number }[];
          if (preview.type === "ITEM" && preview.targetOrderItemId) {
            allocations = [{ orderItemId: preview.targetOrderItemId, quantity: 0, amount: preview.discountAmount }];
          } else {
            const lines = items.map((item) => ({
              key: item.id,
              amount: (item.unitPrice + item.options.reduce((sum, o) => sum + o.extraPriceSnapshot, 0)) * item.quantity,
            }));
            allocations = allocateProportional(preview.discountAmount, lines)
              .filter((row) => row.amount > 0)
              // 할인은 "결제된 수량"을 만들지 않는다 — 수량은 실제 수납(CHARGE)에서만 센다.
              .map((row) => ({ orderItemId: row.key, quantity: 0, amount: row.amount }));
          }

          const created = await tx.payment.create({
            data: {
              tableSessionId: input.tableSessionId,
              kind: "DISCOUNT",
              method: COUPON_DISCOUNT_METHOD,
              amount: preview.discountAmount,
              reason: `쿠폰 ${coupon.code} · ${preview.benefitLabel}`,
              idempotencyKey: scopedKey,
              createdById: input.staffId,
              allocations: { create: allocations },
            },
          });

          await tx.couponRedemption.create({
            data: {
              couponId: coupon.id,
              tableSessionId: input.tableSessionId,
              originalAmount: preview.remainingBefore,
              discountAmount: preview.discountAmount,
              targetOrderItemId: preview.targetOrderItemId,
              targetMenuItemId: preview.targetMenuItemId,
              benefitSnapshot: JSON.stringify(benefit),
              redeemedById: input.staffId,
            },
          });

          return created;
        },
        { maxWait: 10_000, timeout: 20_000 },
      ),
    );

    await recordAuditLogBestEffort({
      actorType: "STAFF",
      actorId: input.staffId,
      action: "COUPON_REDEEMED_TABLE",
      targetType: "TableSession",
      targetId: input.tableSessionId,
      metadata: { paymentId: payment.id, amount: payment.amount, reason: payment.reason },
    });
    appEvents.emit(RealtimeEvent.PaymentRecorded, { tableSessionId: input.tableSessionId, paymentId: payment.id });

    // 쿠폰으로 잔액이 0이 되면 기존 규칙대로 자동 정산/종료가 이어진다.
    const settlement = await maybeAutoSettleTableSession(input.tableSessionId);
    return { payment, bill: await computeBill(input.tableSessionId), settlement, reused: false as const };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.payment.findUnique({ where: { idempotencyKey: scopedKey } });
      if (winner) return { payment: winner, bill: await computeBill(input.tableSessionId), reused: true as const };
    }
    throw err;
  }
}

/**
 * 쿠폰 할인 결제를 취소했을 때 제공 실적도 함께 취소한다(요구사항.md §6.4).
 * 쿠폰 자체는 사용 완료로 유지된다 — 이미 제공한 서비스를 다시 쓰는 사고를 막기 위해서다.
 */
export async function cancelTableCouponRedemption(tableSessionId: string, paymentReason: string | null) {
  const code = paymentReason?.match(/쿠폰\s+(\d{3})/)?.[1];
  const where = code
    ? { tableSessionId, cancelledAt: null, coupon: { code } }
    : { tableSessionId, cancelledAt: null };
  await prisma.couponRedemption.updateMany({ where, data: { cancelledAt: new Date() } });
}
