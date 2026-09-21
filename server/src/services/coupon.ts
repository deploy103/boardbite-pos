import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import type { Db } from "./billing.js";
import { withWriteConflictRetry } from "./writeConflict.js";

/**
 * 쿠폰(요구사항.md §6).
 *
 * CouponBatch(혜택 정의) → Coupon(001~999 고유 번호, 1회 사용) → CouponRedemption(실제 할인 기록).
 *
 * 설계상 지키는 것:
 *   - 번호는 시스템 전체에서 유일하고 **재사용하지 않는다**. 사용/취소/만료된 번호도 다시 발급하지 않는다.
 *     (Coupon.code UNIQUE + "이미 존재하는 번호는 후보에서 제외" 두 겹으로 보장)
 *   - 조회/미리보기는 절대 상태를 바꾸지 않는다. 소진은 결제 확정 트랜잭션 안에서만 일어난다.
 *   - 만료는 배치의 expiresAt으로 파생 판정한다(상태 컬럼을 배치 작업으로 갱신하지 않는다).
 */

export const MAX_COUPON_NUMBER = 999;

export type CouponType = "AMOUNT" | "ITEM";
/** AVAILABLE=사용 가능, USED=사용 완료, EXPIRED=유효기간 만료, CANCELLED=발급 취소. */
export type CouponState = "AVAILABLE" | "USED" | "EXPIRED" | "CANCELLED";

export class CouponError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
  }
}

/**
 * 1 / 01 / 001 을 모두 "001"로 정규화한다. 숫자가 아니거나 000, 1000 이상은 거부한다.
 * 번호는 직원이 눈으로 읽고 입력하는 식별자이므로 공백은 무시한다.
 */
export function normalizeCouponCode(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!/^[0-9]{1,3}$/.test(trimmed)) {
    throw new CouponError("쿠폰 번호는 숫자 1~3자리로 입력해 주세요.", 400, "COUPON_CODE_INVALID");
  }
  const value = Number(trimmed);
  if (value < 1 || value > MAX_COUPON_NUMBER) {
    throw new CouponError(`쿠폰 번호는 001~${MAX_COUPON_NUMBER} 범위예요.`, 400, "COUPON_CODE_INVALID");
  }
  return String(value).padStart(3, "0");
}

/**
 * 만료일 입력 해석(요구사항.md §6.2).
 * 날짜만(YYYY-MM-DD) 주면 **한국시간 그날 23:59:59.999**로 본다. KST=UTC+9이므로 UTC로는 같은 날 14:59:59.999다.
 * 완전한 ISO 문자열이면 그대로 사용한다. 판정은 항상 서버 시간(UTC 기준 Date 비교)으로 한다.
 */
export function parseExpiryInput(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 14, 59, 59, 999));
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new CouponError("만료일 형식이 올바르지 않아요.");
  }
  return parsed;
}

export interface CouponLike {
  status: string;
  batch: { expiresAt: Date | null };
}

export function couponState(coupon: CouponLike, now = new Date()): CouponState {
  if (coupon.status === "CANCELLED") return "CANCELLED";
  if (coupon.status === "USED") return "USED";
  if (coupon.batch.expiresAt && coupon.batch.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "AVAILABLE";
}

export const COUPON_STATE_LABEL: Record<CouponState, string> = {
  AVAILABLE: "사용 가능",
  USED: "사용 완료",
  EXPIRED: "유효기간 만료",
  CANCELLED: "발급 취소",
};

export interface BatchBenefit {
  type: CouponType;
  name: string;
  amount: number | null;
  targets: { menuItemId: string; nameSnapshot: string }[];
}

export function describeBenefit(benefit: BatchBenefit): string {
  if (benefit.type === "AMOUNT") return `${(benefit.amount ?? 0).toLocaleString("ko-KR")}원 할인`;
  const names = benefit.targets.map((t) => t.nameSnapshot).join(" 또는 ");
  return names ? `${names} 중 1개 무료` : "지정 상품 1개 무료";
}

// ---------------------------------------------------------------------------
// 발급
// ---------------------------------------------------------------------------

/**
 * 아직 한 번도 발급되지 않은 번호 중 앞에서부터 `count`개를 고른다.
 * 사용/취소/만료된 쿠폰의 번호도 후보에서 제외되므로 번호가 재사용되지 않는다.
 */
async function allocateCodes(tx: Db, count: number): Promise<string[]> {
  const taken = new Set((await tx.coupon.findMany({ select: { code: true } })).map((c) => c.code));
  const remaining = MAX_COUPON_NUMBER - taken.size;
  if (count > remaining) {
    throw new CouponError(
      remaining <= 0
        ? `쿠폰 번호 ${MAX_COUPON_NUMBER}장을 모두 사용했어요. 더 이상 발급할 수 없어요.`
        : `남은 번호가 ${remaining}장이라 ${count}장을 발급할 수 없어요.`,
      409,
      "COUPON_NUMBERS_EXHAUSTED",
    );
  }
  const codes: string[] = [];
  for (let n = 1; n <= MAX_COUPON_NUMBER && codes.length < count; n++) {
    const code = String(n).padStart(3, "0");
    if (!taken.has(code)) codes.push(code);
  }
  return codes;
}

export interface IssueBatchInput {
  type: CouponType;
  name: string;
  memo?: string;
  amount?: number;
  targetMenuItemIds?: string[];
  quantity: number;
  expiresAt?: string | null;
  idempotencyKey: string;
  createdById: string;
}

/**
 * 배치 발급. 번호 선점부터 쿠폰 생성까지 하나의 트랜잭션으로 처리하므로 "절반만 발급"이 없다.
 * 같은 idempotencyKey 재전송은 최초 배치를 그대로 돌려주고 두 번 발급하지 않는다.
 */
export async function issueCouponBatch(input: IssueBatchInput) {
  const scopedKey = `coupon-batch:${input.createdById}:${input.idempotencyKey}`;

  const existing = await prisma.couponBatch.findUnique({
    where: { idempotencyKey: scopedKey },
    include: { targets: true, coupons: { orderBy: { code: "asc" } } },
  });
  if (existing) return { batch: existing, reused: true as const };

  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_COUPON_NUMBER) {
    throw new CouponError(`발급 수량은 1~${MAX_COUPON_NUMBER}장 사이여야 해요.`);
  }
  const expiresAt = parseExpiryInput(input.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new CouponError("만료일이 이미 지났어요. 오늘 이후 날짜를 선택해 주세요.");
  }

  let amount: number | null = null;
  let targetIds: string[] = [];
  if (input.type === "AMOUNT") {
    if (!Number.isInteger(input.amount) || (input.amount ?? 0) <= 0) {
      throw new CouponError("금액권의 금액은 1원 이상의 정수여야 해요.");
    }
    amount = input.amount!;
  } else {
    targetIds = [...new Set(input.targetMenuItemIds ?? [])];
    if (targetIds.length === 0) {
      throw new CouponError("상품권은 무료로 제공할 메뉴를 1개 이상 지정해야 해요.");
    }
  }

  try {
    const batch = await withWriteConflictRetry(() =>
      prisma.$transaction(async (tx) => {
      let targetRows: { menuItemId: string; nameSnapshot: string }[] = [];
      if (input.type === "ITEM") {
        const items = await tx.menuItem.findMany({ where: { id: { in: targetIds }, deletedAt: null } });
        if (items.length !== targetIds.length) {
          throw new CouponError("현재 판매 중이 아닌 메뉴는 상품권 대상으로 지정할 수 없어요.");
        }
        targetRows = items.map((i) => ({ menuItemId: i.id, nameSnapshot: i.name }));
      }

      const codes = await allocateCodes(tx, input.quantity);

      return tx.couponBatch.create({
        data: {
          type: input.type,
          name: input.name.slice(0, 100),
          memo: input.memo?.slice(0, 300),
          amount,
          expiresAt,
          issuedCount: codes.length,
          idempotencyKey: scopedKey,
          createdById: input.createdById,
          targets: { create: targetRows },
          coupons: { create: codes.map((code) => ({ code })) },
        },
        include: { targets: true, coupons: { orderBy: { code: "asc" } } },
      });
      },
      // 한 번에 최대 999장을 만들 수 있으므로 기본 5초 타임아웃으로는 부족할 수 있다.
      // 발급은 전부 성공하거나 전부 실패해야 하므로(절반 발급 금지) 시간을 넉넉히 준다.
      { maxWait: 10_000, timeout: 30_000 },
      ),
    );
    return { batch, reused: false as const };
  } catch (err) {
    // 동시 발급 경합 — 같은 키가 먼저 커밋됐거나 번호가 겹쳤다. 전자는 최초 결과를 돌려주고,
    // 후자는 아무 쿠폰도 만들어지지 않은 상태이므로(트랜잭션 전체 롤백) 그대로 오류를 알린다.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.couponBatch.findUnique({
        where: { idempotencyKey: scopedKey },
        include: { targets: true, coupons: { orderBy: { code: "asc" } } },
      });
      if (winner) return { batch: winner, reused: true as const };
      throw new CouponError("쿠폰 번호가 방금 다른 발급과 겹쳤어요. 다시 시도해 주세요.", 409, "COUPON_CODE_RACE");
    }
    throw err;
  }
}

/** 발급 화면에서 "지금 몇 장까지 발급할 수 있는가"를 미리 보여준다. */
export async function couponNumberAvailability() {
  const issued = await prisma.coupon.count();
  return { issued, remaining: Math.max(MAX_COUPON_NUMBER - issued, 0), max: MAX_COUPON_NUMBER };
}

/** 미사용 쿠폰 발급 취소. 이미 사용된 쿠폰은 절대 되돌리지 않는다(요구사항.md §6.1). */
export async function cancelCoupons(couponIds: string[], actorId: string) {
  const result = await prisma.$transaction(async (tx) => {
    const cancelled = await tx.coupon.updateMany({
      where: { id: { in: couponIds }, status: "AVAILABLE" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    const skipped = couponIds.length - cancelled.count;
    return { cancelledCount: cancelled.count, skippedCount: skipped };
  });
  void actorId;
  return result;
}

// ---------------------------------------------------------------------------
// 조회 (FRONT 단건 / ADMIN 전체)
// ---------------------------------------------------------------------------

const COUPON_WITH_BATCH = {
  batch: { include: { targets: true } },
  redemptions: { select: { id: true, counterSaleId: true, discountAmount: true, redeemedAt: true, cancelledAt: true } },
} as const;

export type CouponWithBatch = Prisma.CouponGetPayload<{ include: typeof COUPON_WITH_BATCH }>;

/** 배치만 붙어 있으면 되므로 include 형태에 상관없이 쓸 수 있게 최소 타입만 요구한다. */
export interface CouponWithBenefit {
  batch: {
    type: string;
    name: string;
    amount: number | null;
    targets: { menuItemId: string; nameSnapshot: string }[];
  };
}

export function benefitOf(coupon: CouponWithBenefit): BatchBenefit {
  return {
    type: coupon.batch.type as CouponType,
    name: coupon.batch.name,
    amount: coupon.batch.amount,
    targets: coupon.batch.targets.map((t) => ({ menuItemId: t.menuItemId, nameSnapshot: t.nameSnapshot })),
  };
}

export async function findCouponByCode(code: string, db: Db = prisma): Promise<CouponWithBatch | null> {
  return db.coupon.findUnique({ where: { code }, include: COUPON_WITH_BATCH });
}

/**
 * FRONT 쿠폰 번호 조회(요구사항.md §6.2).
 * 업무에 필요한 단건 정보만 돌려주고, 전체 목록/검색은 ADMIN 전용이다.
 * **상태를 바꾸지 않는다** — 소진은 오직 결제 확정 트랜잭션에서만 일어난다.
 */
export async function lookupCouponForFront(rawCode: string) {
  const code = normalizeCouponCode(rawCode);
  const coupon = await findCouponByCode(code);
  if (!coupon) {
    throw new CouponError("존재하지 않는 쿠폰 번호예요.", 404, "COUPON_NOT_FOUND");
  }
  const state = couponState(coupon);
  const benefit = benefitOf(coupon);

  // 상품권 대상 메뉴가 전부 삭제/비활성이면 자동으로 다른 메뉴를 고르지 않고 그대로 알린다.
  let usableTargets: { menuItemId: string; name: string; price: number; isSoldOut: boolean }[] = [];
  if (benefit.type === "ITEM") {
    const items = await prisma.menuItem.findMany({
      where: { id: { in: benefit.targets.map((t) => t.menuItemId) }, deletedAt: null, isActive: true },
      select: { id: true, name: true, price: true, isSoldOut: true },
    });
    usableTargets = items.map((i) => ({ menuItemId: i.id, name: i.name, price: i.price, isSoldOut: i.isSoldOut }));
  }

  return {
    code: coupon.code,
    state,
    stateLabel: COUPON_STATE_LABEL[state],
    benefit,
    benefitLabel: describeBenefit(benefit),
    expiresAt: coupon.batch.expiresAt,
    usableTargets,
    usedAt: coupon.usedAt,
    targetsUnavailable: benefit.type === "ITEM" && usableTargets.length === 0,
  };
}

/** 사용 가능 상태가 아니면 사람이 읽을 수 있는 이유와 함께 거부한다. */
export function assertRedeemable(coupon: CouponWithBatch, now = new Date()): void {
  const state = couponState(coupon, now);
  if (state === "AVAILABLE") return;
  const reason: Record<Exclude<CouponState, "AVAILABLE">, string> = {
    USED: "이미 사용 완료된 쿠폰이에요.",
    EXPIRED: "유효기간이 지난 쿠폰이에요.",
    CANCELLED: "발급이 취소된 쿠폰이에요.",
  };
  throw new CouponError(reason[state], 409, `COUPON_${state}`);
}

/**
 * 쿠폰 소진 — **반드시 결제 확정 트랜잭션 안에서** 호출한다.
 * 조건부 갱신(status='AVAILABLE'인 행만)의 변경 행 수가 1이 아니면 그대로 예외를 던져
 * 트랜잭션 전체를 롤백시킨다. 동일 쿠폰 동시 결제에서 정확히 한 거래만 성공하는 근거다.
 */
export async function consumeCouponInTx(tx: Prisma.TransactionClient, couponId: string, now = new Date()): Promise<void> {
  const claimed = await tx.coupon.updateMany({
    where: { id: couponId, status: "AVAILABLE" },
    data: { status: "USED", usedAt: now },
  });
  if (claimed.count !== 1) {
    throw new CouponError("방금 다른 결제에서 사용된 쿠폰이에요. 번호를 다시 확인해 주세요.", 409, "COUPON_ALREADY_USED");
  }
}

// ---------------------------------------------------------------------------
// ADMIN 목록
// ---------------------------------------------------------------------------

export interface CouponListFilter {
  code?: string;
  type?: CouponType;
  batchId?: string;
  state?: CouponState;
  limit?: number;
}

export async function listCoupons(filter: CouponListFilter) {
  const where: Prisma.CouponWhereInput = {};
  if (filter.code) where.code = { contains: filter.code };
  if (filter.batchId) where.batchId = filter.batchId;
  if (filter.type) where.batch = { type: filter.type };
  // EXPIRED는 파생 상태라 SQL where로 표현하지 않고 아래에서 걸러낸다.
  if (filter.state === "USED" || filter.state === "CANCELLED") where.status = filter.state;
  if (filter.state === "AVAILABLE" || filter.state === "EXPIRED") where.status = "AVAILABLE";

  const rows = await prisma.coupon.findMany({
    where,
    orderBy: { code: "asc" },
    take: Math.min(filter.limit ?? 1000, 1000),
    include: {
      batch: { include: { targets: true, createdBy: { select: { displayName: true } } } },
      redemptions: {
        select: {
          id: true,
          counterSaleId: true,
          discountAmount: true,
          redeemedAt: true,
          cancelledAt: true,
          redeemedBy: { select: { displayName: true } },
          counterSale: { select: { saleNo: true, status: true } },
          tableSession: { select: { id: true, status: true, table: { select: { number: true } } } },
        },
      },
    },
  });

  const now = new Date();
  return rows
    .map((row) => {
      const state = couponState(row, now);
      const benefit: BatchBenefit = {
        type: row.batch.type as CouponType,
        name: row.batch.name,
        amount: row.batch.amount,
        targets: row.batch.targets.map((t) => ({ menuItemId: t.menuItemId, nameSnapshot: t.nameSnapshot })),
      };
      const redemption = row.redemptions[0] ?? null;
      return {
        id: row.id,
        code: row.code,
        state,
        stateLabel: COUPON_STATE_LABEL[state],
        type: benefit.type,
        benefitLabel: describeBenefit(benefit),
        batchId: row.batchId,
        batchName: row.batch.name,
        batchMemo: row.batch.memo,
        issuedAt: row.batch.createdAt,
        issuedBy: row.batch.createdBy.displayName,
        expiresAt: row.batch.expiresAt,
        usedAt: row.usedAt,
        cancelledAt: row.cancelledAt,
        redemption: redemption
          ? {
              // 사용처는 현장 거래(#001) 또는 테이블(3번 테이블) 중 하나다.
              usedAt: redemption.counterSale
                ? { kind: "COUNTER" as const, saleNo: redemption.counterSale.saleNo, status: redemption.counterSale.status }
                : {
                    kind: "TABLE" as const,
                    tableNumber: redemption.tableSession?.table.number ?? null,
                    status: redemption.tableSession?.status ?? null,
                  },
              discountAmount: redemption.discountAmount,
              redeemedAt: redemption.redeemedAt,
              redeemedBy: redemption.redeemedBy.displayName,
              cancelledAt: redemption.cancelledAt,
            }
          : null,
      };
    })
    .filter((row) => (filter.state ? row.state === filter.state : true));
}

export async function listCouponBatches() {
  const batches = await prisma.couponBatch.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      targets: true,
      createdBy: { select: { displayName: true } },
      coupons: { select: { id: true, status: true } },
    },
  });
  const now = new Date();
  return batches.map((batch) => {
    const benefit: BatchBenefit = {
      type: batch.type as CouponType,
      name: batch.name,
      amount: batch.amount,
      targets: batch.targets.map((t) => ({ menuItemId: t.menuItemId, nameSnapshot: t.nameSnapshot })),
    };
    const counts = { AVAILABLE: 0, USED: 0, EXPIRED: 0, CANCELLED: 0 };
    for (const coupon of batch.coupons) {
      counts[couponState({ status: coupon.status, batch: { expiresAt: batch.expiresAt } }, now)] += 1;
    }
    return {
      id: batch.id,
      type: benefit.type,
      name: batch.name,
      memo: batch.memo,
      amount: batch.amount,
      benefitLabel: describeBenefit(benefit),
      targets: benefit.targets,
      issuedCount: batch.issuedCount,
      expiresAt: batch.expiresAt,
      createdAt: batch.createdAt,
      createdBy: batch.createdBy.displayName,
      counts,
    };
  });
}

/**
 * 메뉴 삭제 전에 "이 메뉴를 대상으로 하는 미사용 상품권"을 보여주기 위한 조회(요구사항.md §6.2).
 * 삭제 자체를 막지는 않지만, 남은 상품권이 못 쓰게 되는지 관리자가 먼저 알아야 한다.
 */
export async function unusedItemCouponsForMenuItem(menuItemId: string) {
  const coupons = await prisma.coupon.findMany({
    where: { status: "AVAILABLE", batch: { targets: { some: { menuItemId } } } },
    include: { batch: { include: { targets: true } } },
  });
  const now = new Date();
  const live = coupons.filter((c) => couponState(c, now) === "AVAILABLE");
  return {
    count: live.length,
    /** 이 메뉴가 유일한 대상인 쿠폰 = 삭제하면 아예 쓸 수 없게 되는 쿠폰. */
    soleTargetCount: live.filter((c) => c.batch.targets.length === 1).length,
    codes: live.slice(0, 30).map((c) => c.code),
  };
}
