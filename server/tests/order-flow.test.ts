import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff, loginAgent, createTableWithMenu, openTableAndJoin, joinCustomer } from "./helpers.js";
import { prisma } from "../src/prisma.js";

/**
 * 테이블을 열고, 그 세션의 join code로 손님을 입장시킨다.
 * publicSlug만으로는 아무 권한도 생기지 않으므로(요구사항2.md §2.2) join 단계가 반드시 필요하다.
 */
async function openTableAndEnter(front: Awaited<ReturnType<typeof loginAgent>>, tableId: string, slug: string) {
  const { customer } = await openTableAndJoin(front, tableId, slug);
  const entryRes = await customer.get(`/api/customer/entry/${slug}`);
  expect(entryRes.body.open).toBe(true);
  expect(entryRes.body.joined).toBe(true);
  return customer;
}

describe("주문 생성", () => {
  it("클라이언트가 보낸 가격은 무시되고 서버가 재계산한다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const customer = await openTableAndEnter(front, table.id, table.publicSlug);

    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send({
        idempotencyKey: "price-tamper",
        items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [], price: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.order.items[0].unitPrice).toBe(6000);
  });

  it("동일 idempotencyKey로 동시에 두 번 요청해도 주문은 1건만 생성된다 (더블탭/동시요청 방지)", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const customer = await openTableAndEnter(front, table.id, table.publicSlug);

    const payload = {
      idempotencyKey: "double-tap",
      items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }],
    };

    const [res1, res2] = await Promise.all([
      customer.post("/api/customer/orders").set("X-BoardBite-Client", "1").send(payload),
      customer.post("/api/customer/orders").set("X-BoardBite-Client", "1").send(payload),
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.order.id).toBe(res2.body.order.id);

    const count = await prisma.order.count({ where: { tableSessionId: res1.body.order.tableSessionId } });
    expect(count).toBe(1);
  });

  it("품절 메뉴는 주문할 수 없다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    await prisma.menuItem.update({ where: { id: menuItem.id }, data: { isSoldOut: true } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const customer = await openTableAndEnter(front, table.id, table.publicSlug);

    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "sold-out", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });

    expect(res.status).toBe(400);
  });

  it("CLOSED 테이블에서는 주문할 수 없고, 이전 고객 세션은 즉시 무효화된다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const customer = await openTableAndEnter(front, table.id, table.publicSlug);

    const closeRes = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(closeRes.status).toBe(200);

    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "after-close", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });

    expect(res.status).toBe(403);

    const entryAgain = await request.agent(app).get(`/api/customer/entry/${table.publicSlug}`);
    expect(entryAgain.body.open).toBe(false);
  });

  it("빈 테이블(AVAILABLE)은 다시 열 수 있고, 새 손님은 완전히 새로운 세션을 받는다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);

    const firstCustomer = await openTableAndEnter(front, table.id, table.publicSlug);
    await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});

    const reopenRes = await front
      .post(`/api/staff/front/tables/${table.id}/open`)
      .set("X-BoardBite-Client", "1")
      .send({ guestCount: 4 });
    expect(reopenRes.status).toBe(201);

    const secondCustomer = await joinCustomer(table.publicSlug, reopenRes.body.joinCode);
    const entryRes = await secondCustomer.get(`/api/customer/entry/${table.publicSlug}`);
    expect(entryRes.body.open).toBe(true);
    expect(entryRes.body.joined).toBe(true);

    const secondOrderRes = await secondCustomer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "new-guest", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    expect(secondOrderRes.status).toBe(201);
    expect(secondOrderRes.body.order.tableSessionId).toBe(reopenRes.body.session.id);

    // 이전 고객 쿠키는 여전히 이전(CLOSED) 세션을 가리키므로 재사용 불가
    const staleOrderRes = await firstCustomer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "stale-guest", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    expect(staleOrderRes.status).toBe(403);
  });
});
