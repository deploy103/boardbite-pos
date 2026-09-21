import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import { computeRevenueSummary } from "../src/services/reporting.js";
import { computeClosingPreview } from "../src/services/closing.js";
import { createCounterOnlyItem, createMenuItem, loginAdmin, loginAgent, loginFront } from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

function confirm(front: Awaited<ReturnType<typeof loginAgent>>, body: Record<string, unknown>) {
  return front.post("/api/staff/front/counter/confirm").set(...H).send(body);
}

/** 요구사항.md §9 인수 테스트 14, 15, 17 — 매출/마감/CSV 집계. */
describe("매출·마감 집계 (인수 14, 15, 17)", () => {
  it("17. 쿠폰 할인은 매출·현금 예상액에 들어가지 않고, 결제수단 합계 = 순매출이다", async () => {
    const since = new Date();
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const udon = await createMenuItem({ name: "집계우동", price: 3000, channel: "FRONT" });
    const code = (
      await admin
        .post("/api/staff/admin/coupons/batches")
        .set(...H)
        .send({ idempotencyKey: `rep-${Date.now()}`, type: "AMOUNT", name: "집계권", amount: 1000, quantity: 1 })
    ).body.batch.codes[0];

    // 우동 + 1,000원 금액권 → 현금 2,000원 수납
    await confirm(front, {
      idempotencyKey: `rep1-${Date.now()}`,
      items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
      methodCode: "CASH",
      tenderedAmount: 2000,
    });

    const summary = await computeRevenueSummary(since);
    expect(summary.totalOrderAmount).toBe(3000);
    expect(summary.couponDiscount).toBe(1000);
    expect(summary.manualDiscount).toBe(0);
    expect(summary.totalCharged).toBe(2000);
    expect(summary.totalRevenue).toBe(2000);
    // 쿠폰은 결제수단이 아니다 — byMethod에 COUPON이 없다.
    expect(summary.byMethod.find((m) => m.method === "COUPON")).toBeUndefined();
    // 결제수단 합계 = 순매출
    expect(summary.byMethod.reduce((s, m) => s + m.amount, 0)).toBe(summary.totalRevenue);
    // 현장/테이블 구분
    expect(summary.byChannel.counter).toBe(2000);
    expect(summary.byChannel.table).toBe(0);
    // 검산: 메뉴 배분 + 미배분 = 순매출
    expect(summary.menuPaidRevenue + summary.unallocatedCharged).toBe(summary.totalRevenue);
    // 메뉴별로는 정가 주문액과 실제 수납이 구분된다.
    const row = summary.menuSales.find((m) => m.menuItemId === udon.id)!;
    expect(row.orderAmount).toBe(3000);
    expect(row.paidRevenue).toBe(2000);

    const closing = await computeClosingPreview(since);
    expect(closing.couponDiscount).toBe(1000);
    // 현금 예상액에 쿠폰 1,000원이 섞이지 않는다.
    expect(closing.expectedCash).toBe(2000);
  });

  it("14. 전액 쿠폰 거래는 매출 0이고 쿠폰 제공액으로만 잡힌다", async () => {
    const since = new Date();
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const item = await createMenuItem({ name: "전액무료", price: 4000, channel: "FRONT" });
    const code = (
      await admin
        .post("/api/staff/admin/coupons/batches")
        .set(...H)
        .send({ idempotencyKey: `free-${Date.now()}`, type: "ITEM", name: "전액권", quantity: 1, targetMenuItemIds: [item.id] })
    ).body.batch.codes[0];

    await confirm(front, {
      idempotencyKey: `free1-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      couponCode: code,
    });

    const summary = await computeRevenueSummary(since);
    expect(summary.totalRevenue).toBe(0);
    expect(summary.couponDiscount).toBe(4000);
    expect(summary.coupon.itemCouponDiscount).toBe(4000);
    // 무료 제공 수량이 메뉴별로 집계된다.
    expect(summary.menuSales.find((m) => m.menuItemId === item.id)!.couponFreeCount).toBe(1);
  });

  it("15. 기간 밖 원본에 대한 환불도 환불 시각 기준으로 현재 기간에 반영된다", async () => {
    const { agent: admin, password } = await loginAdmin();
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("기간밖환불", 5000);

    const sale = await confirm(front, {
      idempotencyKey: `period-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CASH",
      tenderedAmount: 5000,
    });

    // 원본 수납을 "이전 기간"으로 밀어 둔다.
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.payment.updateMany({ where: { counterSaleId: sale.body.sale.id }, data: { createdAt: past } });
    await prisma.counterSale.update({ where: { id: sale.body.sale.id }, data: { createdAt: past } });
    await prisma.order.updateMany({ where: { counterSaleId: sale.body.sale.id }, data: { createdAt: past } });

    const since = new Date();
    await admin.post("/api/staff/step-up").set(...H).send({ password });
    await admin
      .post(`/api/staff/admin/counter-sales/${sale.body.sale.id}/cancel`)
      .set(...H)
      .send({ reason: "기간 밖 원본 환불" });

    const summary = await computeRevenueSummary(since);
    // 이 기간에는 수납이 없고 환불만 있으므로 순매출이 음수가 된다 — 숨기지 않고 그대로 드러낸다.
    expect(summary.totalCharged).toBe(0);
    expect(summary.totalRefunded).toBe(5000);
    expect(summary.totalRevenue).toBe(-5000);
    expect(summary.byMethod.reduce((s, m) => s + m.amount, 0)).toBe(-5000);
    expect(summary.menuPaidRevenue + summary.unallocatedCharged).toBe(summary.totalRevenue);
  });

  it("17. 마감 화면이 현장 미수령·환불 필요 건을 보여준다", async () => {
    const { agent: front } = await loginFront();
    const food = await createMenuItem({ name: "마감미수령", price: 2000, channel: "FRONT" });
    const sale = await confirm(front, {
      idempotencyKey: `closing-${Date.now()}`,
      items: [{ menuItemId: food.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });

    const preview = await computeClosingPreview(new Date(Date.now() - 60_000));
    const row = preview.openCounterSales.find((s) => s.id === sale.body.sale.id);
    expect(row).toBeTruthy();
    expect(row!.pickupPending).toBe(true);
  });

  it("매출/마감 CSV가 주문액·쿠폰 할인·현장 매출·검산 항목을 포함한다", async () => {
    const { agent: admin } = await loginAdmin();
    const revenue = await admin.get("/api/staff/admin/export/revenue.csv").set(...H);
    expect(revenue.status).toBe(200);
    expect(revenue.text).toContain("총 주문액(정가)");
    expect(revenue.text).toContain("쿠폰 할인(무료 제공)");
    expect(revenue.text).toContain("현장 순매출");
    expect(revenue.text).toContain("검산(메뉴 배분 + 미배분)");

    const closing = await admin.get("/api/staff/admin/export/closing.csv").set(...H);
    expect(closing.status).toBe(200);
    expect(closing.text).toContain("쿠폰 할인(무료 제공)");
    expect(closing.text).toContain("정리 안 된 현장 거래");
  });

  it("기존 테이블 매출과 현장 매출이 섞이지 않고 각각 집계된다", async () => {
    const since = new Date();
    const { agent: front } = await loginFront();
    const { createTableWithMenu, openTableAndJoin, createStaff, loginAgent: login } = await import("./helpers.js");
    const { table, menuItem } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const tableFront = await login(username, password);
    const { customer } = await openTableAndJoin(tableFront, table.id, table.publicSlug);
    await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: "ch1", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    const session = await prisma.tableSession.findFirstOrThrow({ where: { tableId: table.id }, orderBy: { openedAt: "desc" } });
    await tableFront
      .post(`/api/staff/front/table-sessions/${session.id}/payments`)
      .set(...H)
      .send({ idempotencyKey: "p1", methodCode: "CARD", mode: "AMOUNT", amount: 6000 });

    const counterItem = await createCounterOnlyItem("채널구분", 1500);
    await confirm(front, {
      idempotencyKey: `chan-${Date.now()}`,
      items: [{ menuItemId: counterItem.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });

    const summary = await computeRevenueSummary(since);
    expect(summary.byChannel.table).toBe(6000);
    expect(summary.byChannel.counter).toBe(1500);
    expect(summary.totalRevenue).toBe(7500);
    // 테이블 금액 기반 결제는 배분 근거가 없으므로 '미배분'으로 드러난다(메뉴에 임의 귀속시키지 않는다).
    expect(summary.unallocatedCharged).toBe(6000);
    expect(summary.menuPaidRevenue).toBe(1500);
    // 현장 판매가 테이블 0번으로 표시되지 않는다.
    expect(summary.byTable.every((t) => t.tableNumber !== 0)).toBe(true);
  });
});
