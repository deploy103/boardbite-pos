import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import { computeBill } from "../src/services/billing.js";
import {
  createMenuItem,
  createOrderWithItem,
  createStaff,
  createTableWithMenu,
  loginAdmin,
  loginAgent,
  loginFront,
  openTableSessionDirect,
} from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

async function posAgent() {
  const { username, password } = await createStaff("POS");
  return loginAgent(username, password);
}

/**
 * 요구사항 1절 — 주방 주문 취소가 테이블을 닫지 않는다.
 *
 * 예전 버그: 취소된 주문은 청구액에서 빠지므로 총액 0 / 미수금 0 / 미서빙 0 이 되어
 * maybeAutoSettleTableSession이 "완납하고 다 서빙된 테이블"로 오인하고 세션을 CLOSED로 바꿨다.
 */
describe("주방 주문 취소와 테이블 상태 (요구사항 1절)", () => {
  async function seed(price = 6000) {
    const { table, menuItem } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    const { order, orderItem } = await createOrderWithItem(session.id, menuItem.id, price, 1);
    return { table, menuItem, session, order, orderItem };
  }

  const tableStatus = async (id: string) => (await prisma.table.findUniqueOrThrow({ where: { id } })).status;
  const sessionStatus = async (id: string) => (await prisma.tableSession.findUniqueOrThrow({ where: { id } })).status;

  it("주문을 취소해도 테이블이 열린 상태로 유지된다", async () => {
    const { table, session, order } = await seed();
    const pos = await posAgent();

    const res = await pos
      .post(`/api/staff/pos/orders/${order.id}/cancel`)
      .set(...H)
      .send({ reasonCode: "CUSTOMER_REQUEST" });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("CANCELLED");

    // 핵심 회귀: 세션과 테이블이 그대로 살아 있어야 한다.
    expect(await sessionStatus(session.id)).toBe("ACTIVE");
    expect(await tableStatus(table.id)).toBe("OPEN");
  });

  it("한 테이블의 여러 주문 중 하나만 취소된다", async () => {
    const { table, menuItem, session, order } = await seed(6000);
    const second = await createOrderWithItem(session.id, menuItem.id, 4000, 1);
    const pos = await posAgent();

    await pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send({ reasonCode: "WRONG_ORDER" });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: second.order.id } })).status).toBe("NEW");
    // 남은 주문 금액만 청구된다.
    expect((await computeBill(session.id)).totalAmount).toBe(4000);
    expect(await sessionStatus(session.id)).toBe("ACTIVE");
    expect(await tableStatus(table.id)).toBe("OPEN");
  });

  it("모든 주문이 취소돼도 테이블이 자동 종료되지 않는다", async () => {
    const { table, menuItem, session, order } = await seed(6000);
    const second = await createOrderWithItem(session.id, menuItem.id, 4000, 1);
    const pos = await posAgent();

    for (const id of [order.id, second.order.id]) {
      const res = await pos.post(`/api/staff/pos/orders/${id}/cancel`).set(...H).send({ reasonCode: "CANNOT_COOK" });
      expect(res.status).toBe(200);
    }

    // 청구할 것이 없어도(총액 0 / 미수금 0) 테이블은 그대로다 — 종료는 FRONT의 명시적 작업이다.
    const bill = await computeBill(session.id);
    expect(bill.totalAmount).toBe(0);
    expect(bill.remainingAmount).toBe(0);
    expect(await sessionStatus(session.id)).toBe("ACTIVE");
    expect(await tableStatus(table.id)).toBe("OPEN");
  });

  it("이미 취소된 주문을 다시 취소해도 상태가 깨지지 않는다(멱등)", async () => {
    const { table, session, order } = await seed();
    const pos = await posAgent();
    const body = { reasonCode: "CUSTOMER_REQUEST" as const, note: "중복 요청" };

    const first = await pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send(body);
    const second = await pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.order.status).toBe("CANCELLED");

    // 취소 시각이 두 번 갱신되지 않고, 항목도 한 번만 취소로 기록된다.
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(stored.cancelledAt!.getTime()).toBe(first.body.order.cancelledAt ? new Date(first.body.order.cancelledAt).getTime() : 0);
    expect(stored.items.every((i) => i.cancelledAt !== null)).toBe(true);
    expect(await sessionStatus(session.id)).toBe("ACTIVE");
    expect(await tableStatus(table.id)).toBe("OPEN");
  });

  it("동시에 같은 주문을 취소해도 상태가 일관된다", async () => {
    const { session, order } = await seed();
    const pos = await posAgent();
    const body = { reasonCode: "OTHER" as const };
    const [a, b] = await Promise.all([
      pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send(body),
      pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send(body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
    expect(await sessionStatus(session.id)).toBe("ACTIVE");
  });

  it("주문 항목 하나만 취소하면 그 항목만 빠지고 주문은 살아 있다", async () => {
    const { table, menuItem, session, order } = await seed(6000);
    // 같은 주문에 항목을 하나 더 붙인다.
    const extra = await prisma.orderItem.create({
      data: { orderId: order.id, menuItemId: menuItem.id, nameSnapshot: "추가항목", unitPrice: 2000, quantity: 1 },
    });
    const pos = await posAgent();

    const res = await pos
      .post(`/api/staff/pos/orders/${order.id}/cancel`)
      .set(...H)
      .send({ reasonCode: "CANNOT_COOK", orderItemIds: [extra.id] });
    expect(res.status).toBe(200);
    // 주문 자체는 살아 있다.
    expect(res.body.order.status).toBe("NEW");

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } });
    expect(items.find((i) => i.id === extra.id)!.cancelledAt).not.toBeNull();
    expect(items.find((i) => i.id !== extra.id)!.cancelledAt).toBeNull();
    // 취소된 항목은 청구되지 않는다.
    expect((await computeBill(session.id)).totalAmount).toBe(6000);
    expect(await tableStatus(table.id)).toBe("OPEN");
  });

  it("남은 항목을 모두 취소하면 주문도 취소 상태가 되지만 테이블은 유지된다", async () => {
    const { table, menuItem, session, order, orderItem } = await seed(6000);
    const extra = await prisma.orderItem.create({
      data: { orderId: order.id, menuItemId: menuItem.id, nameSnapshot: "추가", unitPrice: 1000, quantity: 1 },
    });
    const pos = await posAgent();

    await pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send({ reasonCode: "OTHER", orderItemIds: [extra.id] });
    const res = await pos
      .post(`/api/staff/pos/orders/${order.id}/cancel`)
      .set(...H)
      .send({ reasonCode: "OTHER", orderItemIds: [orderItem.id] });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("CANCELLED");
    expect(await sessionStatus(session.id)).toBe("ACTIVE");
    expect(await tableStatus(table.id)).toBe("OPEN");
  });

  it("다른 주문의 항목을 끼워 넣어 취소할 수 없다", async () => {
    const { menuItem, session, order } = await seed();
    const other = await createOrderWithItem(session.id, menuItem.id, 1000, 1);
    const pos = await posAgent();
    const res = await pos
      .post(`/api/staff/pos/orders/${order.id}/cancel`)
      .set(...H)
      .send({ reasonCode: "OTHER", orderItemIds: [other.orderItem.id] });
    expect(res.status).toBe(400);
  });

  it("정산 완료 시에는 정상적으로 테이블이 닫힌다", async () => {
    const { table, session, order } = await seed(6000);
    const { agent: front } = await loginFront();
    // 서빙까지 끝낸 뒤 완납하면 자동 종료된다(기존 동작 유지).
    await prisma.order.update({ where: { id: order.id }, data: { status: "SERVED", servedAt: new Date() } });

    const paid = await front
      .post(`/api/staff/front/table-sessions/${session.id}/payments`)
      .set(...H)
      .send({ idempotencyKey: `pay-${Date.now()}`, methodCode: "CARD", mode: "AMOUNT", amount: 6000 });
    expect(paid.status).toBe(201);
    expect(paid.body.settlement).toBe("CLOSED");
    expect(await sessionStatus(session.id)).toBe("CLOSED");
    expect(await tableStatus(table.id)).toBe("AVAILABLE");
  });

  it("주문을 전부 취소한 뒤 FRONT가 명시적으로 종료하면 닫힌다", async () => {
    const { table, session, order } = await seed();
    const pos = await posAgent();
    const { agent: front } = await loginFront();

    await pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send({ reasonCode: "CUSTOMER_REQUEST" });
    expect(await tableStatus(table.id)).toBe("OPEN");

    const closed = await front.post(`/api/staff/front/tables/${table.id}/close`).set(...H).send({});
    expect(closed.status).toBe(200);
    expect(await sessionStatus(session.id)).toBe("CLOSED");
    expect(await tableStatus(table.id)).toBe("AVAILABLE");
  });

  it("주방 거부도 테이블을 닫지 않는다", async () => {
    const { table, session, order } = await seed();
    const pos = await posAgent();
    const res = await pos.post(`/api/staff/pos/orders/${order.id}/reject`).set(...H).send({ reason: "재료 소진" });
    expect(res.status).toBe(200);
    expect(await sessionStatus(session.id)).toBe("ACTIVE");
    expect(await tableStatus(table.id)).toBe("OPEN");
  });
});

/** 요구사항 2절 — 재료 소진 취소와 즉시 품절 처리. */
describe("재료 소진 취소 (요구사항 2절)", () => {
  it("취소 사유 목록을 서버가 내려준다", async () => {
    const pos = await posAgent();
    const res = await pos.get("/api/staff/pos/cancel-reasons").set(...H);
    expect(res.status).toBe(200);
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toEqual([
      "OUT_OF_STOCK",
      "CUSTOMER_REQUEST",
      "CANNOT_COOK",
      "WRONG_ORDER",
      "OTHER",
    ]);
  });

  it("재료 소진인데 품절 품목을 고르지 않으면 거부된다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    const { order } = await createOrderWithItem(session.id, menuItem.id, 6000, 1);
    const pos = await posAgent();

    const res = await pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send({ reasonCode: "OUT_OF_STOCK" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SOLD_OUT_TARGET_REQUIRED");
    // 아무것도 바뀌지 않았다.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("NEW");
  });

  it("선택한 품목만 품절되고 취소·품절·감사 로그가 한 번에 처리된다", async () => {
    const { agent: admin } = await loginAdmin();
    const pos = await posAgent();
    const { table } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);

    const soldOutTarget = await createMenuItem({ name: "소진대상", price: 3000 });
    const untouched = await createMenuItem({ name: "멀쩡메뉴", price: 3000 });
    const { order } = await createOrderWithItem(session.id, soldOutTarget.id, 3000, 1);

    const before = await prisma.auditLog.count({ where: { action: "ORDER_CANCELLED" } });
    const res = await pos
      .post(`/api/staff/pos/orders/${order.id}/cancel`)
      .set(...H)
      .send({
        reasonCode: "OUT_OF_STOCK",
        note: "계란 다 떨어짐",
        soldOutTargets: [{ kind: "MENU_ITEM", id: soldOutTarget.id }],
      });
    expect(res.status).toBe(200);

    // 1) 주문 취소
    expect(res.body.order.status).toBe("CANCELLED");
    expect(res.body.order.cancelReasonCode).toBe("OUT_OF_STOCK");
    expect(res.body.order.cancelNote).toBe("계란 다 떨어짐");
    expect(res.body.order.cancelledById).toBeTruthy();
    // 2) 선택한 품목만 품절
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: soldOutTarget.id } })).isSoldOut).toBe(true);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: untouched.id } })).isSoldOut).toBe(false);
    // 3) 감사 로그
    expect(await prisma.auditLog.count({ where: { action: "ORDER_CANCELLED" } })).toBe(before + 1);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "ORDER_CANCELLED" }, orderBy: { createdAt: "desc" } });
    const meta = JSON.parse(log.metadata!);
    expect(meta.reasonCode).toBe("OUT_OF_STOCK");
    expect(meta.note).toBe("계란 다 떨어짐");
    expect(meta.tableSessionId).toBe(session.id);
    expect(meta.soldOut.menuItemIds).toContain(soldOutTarget.id);
    // 테이블은 그대로다.
    expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).status).toBe("OPEN");
    void admin;
  });

  it("품절 처리가 실패하면 주문 취소까지 전부 롤백된다", async () => {
    const pos = await posAgent();
    const { table, menuItem } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    const { order } = await createOrderWithItem(session.id, menuItem.id, 3000, 1);

    // 존재하지 않는 품목을 품절 대상으로 보내면 트랜잭션 전체가 실패해야 한다.
    const res = await pos
      .post(`/api/staff/pos/orders/${order.id}/cancel`)
      .set(...H)
      .send({ reasonCode: "OUT_OF_STOCK", soldOutTargets: [{ kind: "MENU_ITEM", id: "does-not-exist" }] });
    expect(res.status).toBe(404);

    // 주문은 취소되지 않았다 — "주문만 취소되고 품절은 안 된" 절반 상태가 없다.
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(stored.status).toBe("NEW");
    expect(stored.cancelledAt).toBeNull();
    expect(stored.items.every((i) => i.cancelledAt === null)).toBe(true);
  });

  it("영향 범위 미리보기는 상태를 바꾸지 않고 함께 품절될 메뉴/옵션 수를 알려준다", async () => {
    const { agent: admin } = await loginAdmin();
    const pos = await posAgent();
    const egg = await createMenuItem({ name: "미리보기계란", price: 500 });
    const ramen = await createMenuItem({ name: "미리보기라면", price: 3000 });
    const g = (await admin.post(`/api/staff/admin/menu/items/${ramen.id}/option-groups`).set(...H).send({ name: "토핑", multiSelect: true })).body.group;
    const choice = (await admin.post(`/api/staff/admin/menu/option-groups/${g.id}/choices`).set(...H).send({ name: "계란 추가", extraPrice: 500 })).body.choice;

    const inv = await admin.post("/api/staff/admin/inventory").set(...H).send({ name: "미리보기물품" });
    for (const target of [{ kind: "MENU_ITEM", id: egg.id }, { kind: "OPTION_CHOICE", id: choice.id }]) {
      await admin.post("/api/staff/admin/inventory/link").set(...H).send({ ...target, inventoryItemId: inv.body.item.id });
    }

    const res = await pos
      .post("/api/staff/pos/sold-out-impact")
      .set(...H)
      .send({ targets: [{ kind: "MENU_ITEM", id: egg.id }] });
    expect(res.status).toBe(200);
    const impact = res.body.impact[0];
    expect(impact.inventoryItem.name).toBe("미리보기물품");
    expect(impact.affectedMenuItems).toHaveLength(1);
    expect(impact.affectedOptionChoices).toHaveLength(1);
    expect(impact.affectedOptionChoices[0].menuItemName).toBe("미리보기라면");
    expect(impact.alreadySoldOut).toBe(false);

    // 미리보기만으로는 아무것도 품절되지 않는다.
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: egg.id } })).isSoldOut).toBe(false);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inv.body.item.id } })).isSoldOut).toBe(false);
  });

  it("장바구니에 담은 뒤 품절되면 주문 확정이 막힌다", async () => {
    const pos = await posAgent();
    const { table, menuItem, category } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { openTableAndJoin } = await import("./helpers.js");
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    // 손님이 메뉴를 확인한 시점에는 판매 중이다.
    const menu = await customer.get("/api/customer/menu").set(...H);
    const shown = (menu.body.categories as { items: { id: string; isSoldOut: boolean }[] }[]).flatMap((c) => c.items).find((i) => i.id === menuItem.id)!;
    expect(shown.isSoldOut).toBe(false);

    // 담아둔 사이에 주방이 품절 처리한다.
    await pos.post("/api/staff/pos/sold-out").set(...H).send({ targets: [{ kind: "MENU_ITEM", id: menuItem.id }], soldOut: true });

    const res = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `cart-${Date.now()}`, items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MENU_SOLD_OUT");
    void category;
  });

  it("화면이 보낸 합계가 서버 계산과 다르면 주문을 거절한다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { openTableAndJoin } = await import("./helpers.js");
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const res = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({
        idempotencyKey: `price-${Date.now()}`,
        expectedTotal: 1, // 실제는 6000원
        items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PRICE_MISMATCH");

    // 맞는 금액이면 통과한다.
    const ok = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({
        idempotencyKey: `price-ok-${Date.now()}`,
        expectedTotal: 6000,
        items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }],
      });
    expect(ok.status).toBe(201);
  });
});
