import { describe, it, expect } from "vitest";
import {
  CLIENT_HEADER as H,
  createMenuItem,
  createStaff,
  elevate,
  loginAdmin,
  loginAgent,
  loginFront,
  openTableSessionDirect,
  createBareTable,
} from "./helpers.js";
import { prisma } from "../src/prisma.js";
import { expandScopes } from "../src/services/dataReset.js";

async function elevatedAdmin() {
  const { agent, password } = await loginAdmin();
  return elevate(agent, password);
}

/** 테이블 결제 1건 + 쿠폰을 쓴 현장 거래 1건 + 재고 물품 연결을 만들어 둔다. */
async function seedActivity() {
  const { agent: admin } = await loginAdmin();
  const { agent: front, username: frontUser } = await loginFront();
  const inventory = await prisma.inventoryItem.create({ data: { name: "초기화계란" } });
  const udon = await createMenuItem({ name: "초기화우동", price: 3000 });
  await prisma.menuItem.update({ where: { id: udon.id }, data: { inventoryItemId: inventory.id } });

  const code = (
    await admin
      .post("/api/staff/admin/coupons/batches")
      .set(...H)
      .send({ idempotencyKey: `reset-${Date.now()}`, type: "AMOUNT", name: "초기화권", amount: 1000, quantity: 1 })
  ).body.batch.codes[0] as string;

  const sale = await front
    .post("/api/staff/front/counter/confirm")
    .set(...H)
    .send({
      idempotencyKey: `reset-sale-${Date.now()}`,
      items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      methodCode: "CASH",
      tenderedAmount: 2000,
    });
  expect(sale.status).toBe(201);

  const table = await createBareTable();
  const session = await openTableSessionDirect(table.id, frontUser);
  await prisma.order.create({
    data: {
      tableSessionId: session.id,
      idempotencyKey: `reset-order-${Date.now()}`,
      items: { create: [{ menuItemId: udon.id, nameSnapshot: "초기화우동", unitPrice: 3000, quantity: 1 }] },
    },
  });
  const paid = await front
    .post(`/api/staff/front/table-sessions/${session.id}/payments`)
    .set(...H)
    .send({ idempotencyKey: `reset-pay-${Date.now()}`, methodCode: "CARD", mode: "AMOUNT", amount: 3000 });
  expect(paid.status).toBe(201);

  return { udon, code, table, inventory };
}

describe("항목별 데이터 초기화 (ADMIN)", () => {
  it("의존 항목을 자동으로 포함한다", () => {
    expect([...expandScopes(["revenue"])].sort()).toEqual(["counterSales", "payments", "revenue", "tables"]);
    expect([...expandScopes(["menu"])].sort()).toEqual(["counterSales", "coupons", "menu", "tables"]);
    expect([...expandScopes(["inventory"])]).toEqual(["inventory"]);
  });

  it("step-up과 확인 문구 없이는 실행되지 않고, FRONT는 접근할 수 없다", async () => {
    const { agent: admin } = await loginAdmin();
    const noStepUp = await admin.post("/api/staff/admin/data-reset").set(...H).send({ scopes: ["coupons"], confirmText: "초기화" });
    expect(noStepUp.status).toBe(403);

    const elevated = await elevatedAdmin();
    const wrongText = await elevated.post("/api/staff/admin/data-reset").set(...H).send({ scopes: ["coupons"], confirmText: "네" });
    expect(wrongText.status).toBe(400);
    const empty = await elevated.post("/api/staff/admin/data-reset").set(...H).send({ scopes: [], confirmText: "초기화" });
    expect(empty.status).toBe(400);

    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    expect((await front.get("/api/staff/admin/data-reset/preview")).status).toBe(403);
  });

  it("거래 기록만 지우면 메뉴·재고·쿠폰·테이블·계정은 남고, 써 본 쿠폰은 다시 사용 가능해진다", async () => {
    const { udon, code, table, inventory } = await seedActivity();
    const admin = await elevatedAdmin();
    const staffBefore = await prisma.staffUser.count();
    const methodsBefore = await prisma.paymentMethod.count();
    const res = await admin
      .post("/api/staff/admin/data-reset")
      .set(...H)
      .send({ scopes: ["tables", "counterSales"], confirmText: "초기화" });
    expect(res.status).toBe(200);
    expect(res.body.result.backup).toMatch(/^boardbite-.*\.db$/);

    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.counterSale.count()).toBe(0);
    expect(await prisma.tableSession.count()).toBe(0);
    expect(await prisma.couponRedemption.count()).toBe(0);

    // 설정성 데이터는 그대로
    expect(await prisma.menuItem.findUnique({ where: { id: udon.id } })).toMatchObject({ inventoryItemId: inventory.id });
    expect(await prisma.table.findUnique({ where: { id: table.id } })).toMatchObject({ status: "AVAILABLE" });
    expect(await prisma.staffUser.count()).toBe(staffBefore);
    expect(await prisma.paymentMethod.count()).toBe(methodsBefore);
    expect(await prisma.coupon.findUnique({ where: { code } })).toMatchObject({ status: "AVAILABLE", usedAt: null });

    const log = await prisma.auditLog.findFirst({ where: { action: "DATA_RESET" }, orderBy: { createdAt: "desc" } });
    expect(log).not.toBeNull();

    // 초기화 후 현장 거래 번호는 1번부터 다시 시작하고, 되살아난 쿠폰으로 다시 결제할 수 있다.
    const { agent: front } = await loginFront();
    const again = await front
      .post("/api/staff/front/counter/confirm")
      .set(...H)
      .send({
        idempotencyKey: `reset-again-${Date.now()}`,
        items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }],
        couponCode: code,
        methodCode: "CASH",
        tenderedAmount: 2000,
      });
    expect(again.status).toBe(201);
    expect((await prisma.counterSale.findFirstOrThrow()).saleNo).toBe(1);
  });

  it("매출현황·쿠폰·재고·메뉴를 모두 고르면 설정 외 데이터가 전부 비워진다", async () => {
    await seedActivity();
    await prisma.closingSettlement.create({
      data: {
        openedAt: new Date(),
        closedAt: new Date(),
        expectedCash: 0,
        actualCash: 0,
        cashDifference: 0,
        totalRevenue: 0,
        totalDiscount: 0,
        totalRefund: 0,
        totalVoid: 0,
        closedById: (await prisma.staffUser.findFirstOrThrow()).id,
        snapshot: "{}",
      },
    });
    const tablesBefore = await prisma.table.count();

    const admin = await elevatedAdmin();
    const res = await admin
      .post("/api/staff/admin/data-reset")
      .set(...H)
      .send({ scopes: ["revenue", "coupons", "inventory", "menu"], confirmText: "초기화" });
    expect(res.status).toBe(200);

    for (const count of [
      prisma.closingSettlement.count(),
      prisma.payment.count(),
      prisma.order.count(),
      prisma.coupon.count(),
      prisma.couponBatch.count(),
      prisma.inventoryItem.count(),
      prisma.menuItem.count(),
      prisma.menuCategory.count(),
      prisma.optionChoice.count(),
    ]) {
      expect(await count).toBe(0);
    }
    expect(await prisma.table.count()).toBe(tablesBefore);
    expect(await prisma.staffUser.count()).toBeGreaterThan(0);
  });
});
