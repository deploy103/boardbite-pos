import { prisma } from "../prisma.js";
import { recordAuditLogBestEffort } from "./auditLog.js";
import { createBackup } from "./backup.js";
import { appEvents, RealtimeEvent } from "../realtime.js";

/**
 * 항목별 데이터 초기화 — 리허설/테스트 데이터를 지우고 메뉴·계정 설정은 그대로 둔 채 영업을 시작하기 위한 기능.
 *
 * 과거 이력을 절대 지우지 않는다는 운영 원칙(AGENTS.md 불변조건 2)의 **명시적 예외**다. 그래서
 *   - ADMIN + step-up 재인증 + 확인 문구 입력을 모두 요구하고(라우트),
 *   - 지우기 직전에 DB 백업을 자동으로 만들어 되돌릴 길을 남기며,
 *   - 무엇을 몇 건 지웠는지 감사 로그에 기록한다(감사 로그 자체는 지우지 않는다).
 *
 * 항상 남기는 것: 직원 계정·로그인 세션, 결제수단, 운영 설정, 이용권, 감사 로그, 백업 파일.
 * 테이블은 **정의(번호·이름·QR 주소)를 남기고** 이용 기록만 지운다 — 이미 인쇄/부착한 QR·NFC가
 * 그대로 동작해야 하기 때문이다.
 */

export const RESET_SCOPES = ["tables", "counterSales", "payments", "revenue", "coupons", "inventory", "menu"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

/**
 * 외래키 때문에 혼자서는 지울 수 없는 항목의 의존 관계.
 *   - 결제내역: 모든 결제는 테이블 이용 또는 현장 거래에 속한다. 결제만 지우면 "주문은 있는데 결제가 없는"
 *     미정산처럼 보이는 기록이 남으므로 두 거래 기록을 함께 지운다.
 *   - 매출현황: 매출은 결제 원장에서 계산된다. 결제내역 + 영업 마감 기록.
 *   - 메뉴: 과거 주문 항목과 상품권 대상이 메뉴를 참조한다. 주문 기록과 쿠폰이 먼저 사라져야 한다.
 */
const DEPENDS_ON: Record<ResetScope, ResetScope[]> = {
  tables: [],
  counterSales: [],
  payments: ["tables", "counterSales"],
  revenue: ["payments"],
  coupons: [],
  inventory: [],
  menu: ["tables", "counterSales", "coupons"],
};

export class DataResetError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** 선택한 항목 + 함께 지워져야 하는 항목(재귀). */
export function expandScopes(selected: readonly ResetScope[]): Set<ResetScope> {
  const out = new Set<ResetScope>();
  const visit = (s: ResetScope) => {
    if (out.has(s)) return;
    out.add(s);
    DEPENDS_ON[s].forEach(visit);
  };
  selected.forEach(visit);
  return out;
}

/** 화면에 보여줄 항목별 현재 건수. */
export async function computeResetPreview() {
  const [
    tableSessions,
    tableOrders,
    counterSales,
    payments,
    closings,
    couponBatches,
    coupons,
    inventoryItems,
    menuCategories,
    menuItems,
    tables,
  ] = await Promise.all([
    prisma.tableSession.count(),
    prisma.order.count({ where: { tableSessionId: { not: null } } }),
    prisma.counterSale.count(),
    prisma.payment.count(),
    prisma.closingSettlement.count(),
    prisma.couponBatch.count(),
    prisma.coupon.count(),
    prisma.inventoryItem.count(),
    prisma.menuCategory.count(),
    prisma.menuItem.count(),
    prisma.table.count(),
  ]);
  return {
    counts: {
      tables: { tableSessions, tableOrders, tables },
      counterSales: { counterSales },
      payments: { payments },
      revenue: { closings },
      coupons: { couponBatches, coupons },
      inventory: { inventoryItems },
      menu: { menuCategories, menuItems },
    },
    dependsOn: DEPENDS_ON,
  };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Owner = { tableSessionId: { not: null } } | { counterSaleId: { not: null } };

/**
 * 한 소유자(테이블 이용 / 현장 거래)에 속한 주문·결제·쿠폰 사용 기록을 지운다.
 * 사용 기록이 사라진 쿠폰은 다시 사용 가능 상태로 되돌린다 — 리허설 때 써 본 종이 쿠폰을
 * 축제 당일 그대로 나눠줄 수 있어야 하기 때문이다(발급 취소된 쿠폰은 그대로 둔다).
 */
async function deleteLedgerOf(tx: Tx, owner: Owner) {
  const redemptions = await tx.couponRedemption.findMany({ where: owner, select: { couponId: true } });
  const couponIds = redemptions.map((r) => r.couponId);
  const redemptionCount = (await tx.couponRedemption.deleteMany({ where: owner })).count;
  const restoredCoupons =
    couponIds.length === 0
      ? 0
      : (
          await tx.coupon.updateMany({
            where: { id: { in: couponIds }, status: "USED" },
            data: { status: "AVAILABLE", usedAt: null },
          })
        ).count;

  // 결제 배분 → 결제(취소/환불 행이 원 결제를 참조하므로 역방향 행부터) → 주문 옵션 → 주문 항목 → 주문
  await tx.paymentAllocation.deleteMany({ where: { payment: owner } });
  await tx.paymentAllocation.deleteMany({ where: { orderItem: { order: owner } } });
  await tx.payment.deleteMany({ where: { ...owner, reversedPaymentId: { not: null } } });
  const payments = (await tx.payment.deleteMany({ where: owner })).count;
  await tx.orderItemOption.deleteMany({ where: { orderItem: { order: owner } } });
  await tx.orderItem.deleteMany({ where: { order: owner } });
  const orders = (await tx.order.deleteMany({ where: owner })).count;
  return { orders, payments, redemptions: redemptionCount, restoredCoupons };
}

export async function resetData(selected: readonly ResetScope[], actorId: string) {
  if (selected.length === 0) throw new DataResetError("초기화할 항목을 하나 이상 골라 주세요.");
  const scopes = expandScopes(selected);

  // 되돌릴 수 있도록 지우기 전에 반드시 백업한다. 백업이 실패하면 아무것도 지우지 않는다.
  const backup = await createBackup(actorId);

  // 강제로 닫히는 손님 화면에 알려주기 위해 지우기 전에 열린 세션을 기억해 둔다.
  const liveSessions = scopes.has("tables")
    ? await prisma.tableSession.findMany({
        where: { status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
        select: { id: true, tableId: true },
      })
    : [];

  const deleted = await prisma.$transaction(
    async (tx) => {
      const result: Record<string, number> = {};

      if (scopes.has("tables")) {
        const r = await deleteLedgerOf(tx, { tableSessionId: { not: null } });
        await tx.tableGameUsage.deleteMany({});
        await tx.staffCallRequest.deleteMany({});
        await tx.customerDeviceSession.deleteMany({});
        result.tableSessions = (await tx.tableSession.deleteMany({})).count;
        result.tableOrders = r.orders;
        result.tablePayments = r.payments;
        result.restoredCoupons = (result.restoredCoupons ?? 0) + r.restoredCoupons;
        // 사용 중지(DISABLED)는 ADMIN이 일부러 내린 설정이므로 유지하고, 열려 있던 테이블만 비운다.
        await tx.table.updateMany({ where: { status: { in: ["OPEN", "SETTLING"] } }, data: { status: "AVAILABLE" } });
      }

      if (scopes.has("counterSales")) {
        const r = await deleteLedgerOf(tx, { counterSaleId: { not: null } });
        // 전부 지우면 다음 주문번호는 1번부터 다시 시작한다(saleNo = 최대값 + 1).
        result.counterSales = (await tx.counterSale.deleteMany({})).count;
        result.counterOrders = r.orders;
        result.counterPayments = r.payments;
        result.restoredCoupons = (result.restoredCoupons ?? 0) + r.restoredCoupons;
      }

      if (scopes.has("revenue")) {
        result.closings = (await tx.closingSettlement.deleteMany({})).count;
      }

      if (scopes.has("coupons")) {
        await tx.couponRedemption.deleteMany({});
        result.coupons = (await tx.coupon.deleteMany({})).count;
        await tx.couponBatchTarget.deleteMany({});
        result.couponBatches = (await tx.couponBatch.deleteMany({})).count;
        delete result.restoredCoupons; // 쿠폰 자체가 지워졌으므로 되돌린 건수는 의미가 없다.
      }

      if (scopes.has("inventory")) {
        // 메뉴는 남기고 연결만 끊는다 — 끊긴 메뉴/선택지는 각자의 품절 값으로 돌아간다.
        await tx.menuItem.updateMany({ where: { inventoryItemId: { not: null } }, data: { inventoryItemId: null } });
        await tx.optionChoice.updateMany({ where: { inventoryItemId: { not: null } }, data: { inventoryItemId: null } });
        result.inventoryItems = (await tx.inventoryItem.deleteMany({})).count;
      }

      if (scopes.has("menu")) {
        // 이 시점에는 이를 참조하던 주문·쿠폰이 모두 지워졌으므로 논리 삭제가 아니라 물리 삭제한다.
        await tx.optionChoice.deleteMany({});
        await tx.optionGroup.deleteMany({});
        result.menuItems = (await tx.menuItem.deleteMany({})).count;
        result.menuCategories = (await tx.menuCategory.deleteMany({})).count;
      }

      return result;
    },
    // 데이터가 많으면 기본 5초를 넘길 수 있다. 축제 전 한산한 시점에 한 번 실행하는 작업이다.
    { timeout: 60_000, maxWait: 10_000 },
  );

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId,
    action: "DATA_RESET",
    metadata: { selected: [...selected], applied: [...scopes], deleted, backup: backup.filename },
  });

  for (const s of liveSessions) {
    appEvents.emit(RealtimeEvent.TableClosed, { tableId: s.tableId, tableSessionId: s.id });
  }
  // 모든 화면(손님 메뉴·FRONT·주방·관리자)이 목록을 다시 읽게 한다.
  appEvents.emit(RealtimeEvent.MenuAvailabilityChanged, {});

  return { applied: RESET_SCOPES.filter((s) => scopes.has(s)), deleted, backup: backup.filename };
}
