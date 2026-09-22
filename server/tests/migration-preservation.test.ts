import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(serverDir, "prisma", "migrations");

/** 이번 확장 이전까지의 migration들 — 기존 운영 DB가 이 상태다. */
const PREVIOUS_MIGRATIONS = [
  "20260911122736_init",
  "20260911132320_payments_settings",
  "20260918142917_hardening_auth_customer_sessions_settlement",
  "20260920184552_totp_replay_protection",
];
/** 이번 확장이 추가한 migration들 — 순서대로 적용된다. */
const NEW_MIGRATIONS = [
  "20260921023651_counter_sales_coupons_menu_lifecycle",
  "20260921042345_coupon_redemption_on_table_sessions",
  "20260921114302_option_choice_stock_link",
  "20260922021825_inventory_items_and_item_cancellation",
  "20260922053933_option_group_select_range",
];

let workDir: string;
let dbUrl: string;
let db: PrismaClient;

function exec(file: string) {
  execFileSync("npx", ["prisma", "db", "execute", "--url", dbUrl, "--file", file], {
    cwd: serverDir,
    stdio: "pipe",
  });
}

function applyMigration(name: string) {
  exec(path.join(migrationsDir, name, "migration.sql"));
}

/**
 * 요구사항.md §9 인수 20 / §12.4 — **기존 데이터가 들어 있는 DB**에 migration을 적용해
 * 주문·옵션·결제·마감·게임 이용권 이력이 그대로 보존되는지 확인한다.
 *
 * 이 테스트는 운영 DB를 건드리지 않는다. 이전 버전 migration만 적용한 임시 DB를 새로 만들고,
 * 대표 데이터를 넣은 뒤 새 migration을 올려 행 수·금액 합계·외래키 무결성을 대조한다.
 */
describe("데이터 보존 migration (인수 20)", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "boardbite-migration-"));
    const dbFile = path.join(workDir, "legacy.db");
    dbUrl = `file:${dbFile}`;

    for (const name of PREVIOUS_MIGRATIONS) applyMigration(name);

    // ---- 이전 스키마 기준 대표 운영 데이터 ----
    const seed = path.join(workDir, "seed.sql");
    writeFileSync(
      seed,
      `
INSERT INTO "StaffUser" ("id","username","passwordHash","displayName","role","isActive","mustResetPassword","isBootstrap","createdAt","authVersion","mfaEnabled")
  VALUES ('u1','legacy_admin','hash','관리자','ADMIN',1,0,1,CURRENT_TIMESTAMP,1,0);
INSERT INTO "Table" ("id","number","status","publicSlug","sortOrder","ordersLocked","paymentsLocked","createdAt")
  VALUES ('t1',1,'AVAILABLE','legacy-slug',0,0,0,CURRENT_TIMESTAMP);
INSERT INTO "TableSession" ("id","tableId","status","openedById","openedAt","closedAt","closeReason")
  VALUES ('ts1','t1','CLOSED','u1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'FORCE_CLOSED');
INSERT INTO "MenuCategory" ("id","name","sortOrder") VALUES ('c1','분식',0);
INSERT INTO "MenuItem" ("id","categoryId","name","price","isActive","isSoldOut","needsCooking","showInKitchen","sortOrder","createdAt")
  VALUES ('m1','c1','옛날우동',3000,1,0,1,1,0,CURRENT_TIMESTAMP);
INSERT INTO "MenuItem" ("id","categoryId","name","price","isActive","isSoldOut","needsCooking","showInKitchen","sortOrder","createdAt")
  VALUES ('m2','c1','곧삭제될메뉴',2000,1,0,1,1,1,CURRENT_TIMESTAMP);
INSERT INTO "OptionGroup" ("id","menuItemId","name","required","multiSelect","sortOrder")
  VALUES ('g1','m1','굵기',1,0,0);
INSERT INTO "OptionChoice" ("id","groupId","name","extraPrice","isActive","sortOrder")
  VALUES ('oc1','g1','보통',0,1,0);
INSERT INTO "Order" ("id","tableSessionId","status","idempotencyKey","createdAt")
  VALUES ('o1','ts1','SERVED','legacy-order-1',CURRENT_TIMESTAMP);
INSERT INTO "OrderItem" ("id","orderId","menuItemId","nameSnapshot","unitPrice","quantity")
  VALUES ('oi1','o1','m1','옛날우동',3000,2);
INSERT INTO "OrderItem" ("id","orderId","menuItemId","nameSnapshot","unitPrice","quantity")
  VALUES ('oi2','o1','m2','곧삭제될메뉴',2000,1);
INSERT INTO "OrderItemOption" ("id","orderItemId","optionChoiceId","nameSnapshot","extraPriceSnapshot")
  VALUES ('oio1','oi1','oc1','보통',0);
INSERT INTO "PaymentMethod" ("id","code","name","isCash","isActive","sortOrder") VALUES ('pm1','CASH','현금',1,1,0);
INSERT INTO "Payment" ("id","tableSessionId","kind","method","amount","tenderedAmount","changeAmount","idempotencyKey","createdById","createdAt")
  VALUES ('p1','ts1','CHARGE','CASH',8000,10000,2000,'legacy-pay-1','u1',CURRENT_TIMESTAMP);
INSERT INTO "PaymentAllocation" ("id","paymentId","orderItemId","quantity","amount")
  VALUES ('pa1','p1','oi1',2,6000);
INSERT INTO "GameTimePlan" ("id","name","minutes","price","isActive") VALUES ('gp1','20분',20,1000,1);
INSERT INTO "TableGameUsage" ("id","tableSessionId","planId","minutes","price","startedAt","endsAt")
  VALUES ('gu1','ts1','gp1',20,1000,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO "ClosingSettlement" ("id","openedAt","closedAt","expectedCash","actualCash","cashDifference","totalRevenue","totalDiscount","totalRefund","totalVoid","closedById","snapshot","createdAt")
  VALUES ('cs1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,8000,8000,0,8000,0,0,0,'u1','{}',CURRENT_TIMESTAMP);
INSERT INTO "AuditLog" ("id","actorType","action","prevHash","hash","hashVersion","createdAt")
  VALUES ('a1','STAFF','PAYMENT_CREATED','0','h1',2,CURRENT_TIMESTAMP);
`,
    );
    exec(seed);

    // ---- 이번 확장 migration 적용 ----
    for (const name of NEW_MIGRATIONS) applyMigration(name);

    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it("기존 행이 하나도 사라지지 않는다", async () => {
    expect(await db.staffUser.count()).toBe(1);
    expect(await db.table.count()).toBe(1);
    expect(await db.tableSession.count()).toBe(1);
    expect(await db.menuCategory.count()).toBe(1);
    expect(await db.menuItem.count()).toBe(2);
    expect(await db.optionGroup.count()).toBe(1);
    expect(await db.optionChoice.count()).toBe(1);
    expect(await db.order.count()).toBe(1);
    expect(await db.orderItem.count()).toBe(2);
    expect(await db.orderItemOption.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
    expect(await db.paymentAllocation.count()).toBe(1);
    expect(await db.gameTimePlan.count()).toBe(1);
    expect(await db.tableGameUsage.count()).toBe(1);
    expect(await db.closingSettlement.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(1);
  });

  it("금액 원장 합계가 그대로다", async () => {
    const payment = await db.payment.findUniqueOrThrow({ where: { id: "p1" }, include: { allocations: true } });
    expect(payment.amount).toBe(8000);
    expect(payment.tenderedAmount).toBe(10000);
    expect(payment.changeAmount).toBe(2000);
    expect(payment.tableSessionId).toBe("ts1");
    expect(payment.counterSaleId).toBeNull();
    expect(payment.allocations[0].amount).toBe(6000);

    const closing = await db.closingSettlement.findUniqueOrThrow({ where: { id: "cs1" } });
    expect(closing.totalRevenue).toBe(8000);
    expect(closing.expectedCash).toBe(8000);
  });

  it("새 컬럼은 기존 동작을 유지하는 기본값으로 채워진다", async () => {
    const items = await db.menuItem.findMany({ orderBy: { id: "asc" } });
    // 기존 메뉴는 전부 BOTH — 기존 테이블 판매 가능성이 그대로 유지된다.
    expect(items.every((i) => i.channel === "BOTH")).toBe(true);
    expect(items.every((i) => i.deletedAt === null)).toBe(true);

    const orderItems = await db.orderItem.findMany();
    // 지금까지의 모든 주문은 주방을 거쳤다.
    expect(orderItems.every((i) => i.servingMode === "KITCHEN")).toBe(true);

    const group = await db.optionGroup.findUniqueOrThrow({ where: { id: "g1" } });
    expect(group.isActive).toBe(true);
    expect(group.deletedAt).toBeNull();
    // 옛 required=true / multiSelect=false 가 범위로 정확히 환산된다(동작 동일).
    expect(group.minSelect).toBe(1);
    expect(group.maxSelect).toBe(1);

    // 기존 선택지는 공용 물품 연결 없이(NULL), 품절 아님으로 복사돼 지금까지의 동작이 유지된다.
    const choice = await db.optionChoice.findUniqueOrThrow({ where: { id: "oc1" } });
    expect(choice.inventoryItemId).toBeNull();
    expect(choice.isSoldOut).toBe(false);
    expect(choice.sortOrder).toBe(0);

    // 기존 주문/항목은 취소된 적이 없는 상태로 복사된다.
    const order = await db.order.findUniqueOrThrow({ where: { id: "o1" } });
    expect(order.cancelReasonCode).toBeNull();
    expect(order.cancelledById).toBeNull();
    const orderItem = await db.orderItem.findUniqueOrThrow({ where: { id: "oi1" } });
    expect(orderItem.cancelledAt).toBeNull();

    // 과거 주문의 "그때 그룹명"은 지어내지 않고 NULL로 남긴다.
    const option = await db.orderItemOption.findUniqueOrThrow({ where: { id: "oio1" } });
    expect(option.groupNameSnapshot).toBeNull();
    expect(option.nameSnapshot).toBe("보통");
  });

  it("외래키 무결성이 깨지지 않는다", async () => {
    const violations = await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
    expect(violations).toHaveLength(0);
    const integrity = await db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check");
    expect(integrity[0].integrity_check).toBe("ok");
  });

  it("거래 소유자 CHECK 제약과 UNIQUE 제약이 새 DB에 실제로 걸려 있다", async () => {
    // 소유자 없음
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Order" ("id","status","idempotencyKey","createdAt") VALUES ('bad-none','NEW','bad-none',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
    // 결제도 동일
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Payment" ("id","kind","method","amount","idempotencyKey","createdById","createdAt") VALUES ('bad-pay','CHARGE','CASH',1,'bad-pay','u1',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
    // 쿠폰 번호 UNIQUE
    await db.$executeRawUnsafe(
      `INSERT INTO "CouponBatch" ("id","type","name","issuedCount","idempotencyKey","createdById","createdAt") VALUES ('cb1','AMOUNT','n',1,'k1','u1',CURRENT_TIMESTAMP)`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "Coupon" ("id","batchId","code","status","createdAt") VALUES ('cp1','cb1','001','AVAILABLE',CURRENT_TIMESTAMP)`,
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "Coupon" ("id","batchId","code","status","createdAt") VALUES ('cp2','cb1','001','AVAILABLE',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
    // 쿠폰 사용처는 현장 거래 또는 테이블 세션 중 정확히 하나여야 한다
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "CouponRedemption" ("id","couponId","originalAmount","discountAmount","benefitSnapshot","redeemedById","redeemedAt") VALUES ('bad-owner','cp1',1,1,'{}','u1',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
    // 쿠폰 1장 = 사용 1회 (CouponRedemption.couponId UNIQUE)
    await db.$executeRawUnsafe(
      `INSERT INTO "CounterSale" ("id","saleNo","status","createdById","createdAt","idempotencyKey","requestHash") VALUES ('sale1',1,'COMPLETED','u1',CURRENT_TIMESTAMP,'ik1','rh1')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "CouponRedemption" ("id","couponId","counterSaleId","originalAmount","discountAmount","benefitSnapshot","redeemedById","redeemedAt") VALUES ('r1','cp1','sale1',1000,500,'{}','u1',CURRENT_TIMESTAMP)`,
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "CouponRedemption" ("id","couponId","counterSaleId","originalAmount","discountAmount","benefitSnapshot","redeemedById","redeemedAt") VALUES ('r2','cp1','sale1',1000,500,'{}','u1',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
  });

  it("삭제 예정 메뉴를 참조하는 과거 주문은 논리 삭제 후에도 그대로 조회된다", async () => {
    await db.menuItem.update({ where: { id: "m2" }, data: { deletedAt: new Date(), isActive: false } });
    const item = await db.orderItem.findUniqueOrThrow({ where: { id: "oi2" }, include: { menuItem: true } });
    expect(item.nameSnapshot).toBe("곧삭제될메뉴");
    expect(item.unitPrice).toBe(2000);
    expect(item.menuItem.deletedAt).not.toBeNull();
    const violations = await db.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
    expect(violations).toHaveLength(0);
  });

  it("직전 버전의 옵션→메뉴 연결이 공용 물품으로 승격돼 동작이 유지된다", async () => {
    // 이 DB는 linkedMenuItemId가 없던 시점의 데이터라 승격 대상이 없다 —
    // 승격 SQL이 빈 입력에서도 안전하게 동작하는지(오류 없이 0건 처리) 확인한다.
    expect(await db.inventoryItem.count()).toBe(0);

    // 새 모델로 직접 연결하면 품절이 공유된다.
    const inventory = await db.inventoryItem.create({ data: { name: "이관검증물품" } });
    await db.menuItem.update({ where: { id: "m1" }, data: { inventoryItemId: inventory.id } });
    await db.optionChoice.update({ where: { id: "oc1" }, data: { inventoryItemId: inventory.id } });
    await db.inventoryItem.update({ where: { id: inventory.id }, data: { isSoldOut: true } });

    const menu = await db.menuItem.findUniqueOrThrow({ where: { id: "m1" }, include: { inventoryItem: true } });
    const choice = await db.optionChoice.findUniqueOrThrow({ where: { id: "oc1" }, include: { inventoryItem: true } });
    expect(menu.inventoryItem!.isSoldOut).toBe(true);
    expect(choice.inventoryItem!.isSoldOut).toBe(true);
    // 각자의 로컬 플래그는 건드리지 않았다 — 값이 복사되지 않으므로 어긋날 수 없다.
    expect(menu.isSoldOut).toBe(false);
    expect(choice.isSoldOut).toBe(false);
  });

  it("기존 게임 시간제 이용 이력이 보존되고 새 현장 판매와 중복 청구되지 않는다", async () => {
    const usage = await db.tableGameUsage.findUniqueOrThrow({ where: { id: "gu1" }, include: { plan: true } });
    expect(usage.price).toBe(1000);
    expect(usage.plan.name).toBe("20분");
    // 게임 이용료는 OrderItem이 아니므로 메뉴 매출/현장 판매와 별개 항목으로 남는다.
    expect(await db.orderItem.count({ where: { nameSnapshot: "20분" } })).toBe(0);
  });
});
