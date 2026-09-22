import { describe, it, expect } from "vitest";
import { createStaff, loginAgent, createTableWithMenu, openTableAndJoin } from "./helpers.js";
import { prisma } from "../src/prisma.js";

describe("POS/KDS 주문 상태 전이", () => {
  async function setupOrder() {
    const { table, menuItem } = await createTableWithMenu();
    const front = await loginAgent((await createStaff("FRONT")).username, "testpass1234");
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);
    const orderRes = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "pos-flow", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    expect(orderRes.status).toBe(201);

    const pos = await loginAgent((await createStaff("POS")).username, "testpass1234");
    return { orderId: orderRes.body.order.id as string, pos, menuItem };
  }

  it("정상 흐름: 접수 → 조리시작 → 준비완료", async () => {
    const { orderId, pos } = await setupOrder();

    const accept = await pos.post(`/api/staff/pos/orders/${orderId}/accept`).set("X-BoardBite-Client", "1").send();
    expect(accept.status).toBe(200);
    expect(accept.body.order.status).toBe("ACCEPTED");

    const preparing = await pos.post(`/api/staff/pos/orders/${orderId}/start-preparing`).set("X-BoardBite-Client", "1").send();
    expect(preparing.status).toBe(200);
    expect(preparing.body.order.status).toBe("PREPARING");

    const ready = await pos.post(`/api/staff/pos/orders/${orderId}/ready`).set("X-BoardBite-Client", "1").send();
    expect(ready.status).toBe(200);
    expect(ready.body.order.status).toBe("READY");

    const logs = await prisma.auditLog.findMany({ where: { targetId: orderId }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["ORDER_CREATED", "ORDER_ACCEPTED", "ORDER_PREPARING", "ORDER_READY"]);
  });

  it("잘못된 순서의 상태 전이는 409로 차단된다 (조리시작 없이 준비완료 시도)", async () => {
    const { orderId, pos } = await setupOrder();
    await pos.post(`/api/staff/pos/orders/${orderId}/accept`).set("X-BoardBite-Client", "1").send();

    const res = await pos.post(`/api/staff/pos/orders/${orderId}/ready`).set("X-BoardBite-Client", "1").send();
    expect(res.status).toBe(409);
  });

  it("이미 접수된 주문을 다시 접수하면 409", async () => {
    const { orderId, pos } = await setupOrder();
    await pos.post(`/api/staff/pos/orders/${orderId}/accept`).set("X-BoardBite-Client", "1").send();
    const res = await pos.post(`/api/staff/pos/orders/${orderId}/accept`).set("X-BoardBite-Client", "1").send();
    expect(res.status).toBe(409);
  });

  it("거부 시 사유가 없으면 400, 사유가 있으면 REJECTED로 전이되고 감사로그에 사유가 남는다", async () => {
    const { orderId, pos } = await setupOrder();

    const missing = await pos.post(`/api/staff/pos/orders/${orderId}/reject`).set("X-BoardBite-Client", "1").send({});
    expect(missing.status).toBe(400);

    const res = await pos
      .post(`/api/staff/pos/orders/${orderId}/reject`)
      .set("X-BoardBite-Client", "1")
      .send({ reason: "재료 소진" });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("REJECTED");

    const log = await prisma.auditLog.findFirst({ where: { targetId: orderId, action: "ORDER_REJECTED" } });
    expect(log).not.toBeNull();
    expect(JSON.parse(log!.metadata ?? "{}").reason).toBe("재료 소진");
  });

  it("READY 상태의 주문은 취소할 수 없다 (NEW/ACCEPTED/PREPARING만 취소 가능)", async () => {
    const { orderId, pos } = await setupOrder();
    await pos.post(`/api/staff/pos/orders/${orderId}/accept`).set("X-BoardBite-Client", "1").send();
    await pos.post(`/api/staff/pos/orders/${orderId}/start-preparing`).set("X-BoardBite-Client", "1").send();
    await pos.post(`/api/staff/pos/orders/${orderId}/ready`).set("X-BoardBite-Client", "1").send();

    const res = await pos
      .post(`/api/staff/pos/orders/${orderId}/cancel`)
      .set("X-BoardBite-Client", "1")
      .send({ reasonCode: "CUSTOMER_REQUEST" });
    expect(res.status).toBe(409);
  });

  it("FRONT 계정은 POS 주문 상태 API를 호출할 수 없다 (403)", async () => {
    const { orderId } = await setupOrder();
    const otherFront = await loginAgent((await createStaff("FRONT")).username, "testpass1234");
    const res = await otherFront.post(`/api/staff/pos/orders/${orderId}/accept`).set("X-BoardBite-Client", "1").send();
    expect(res.status).toBe(403);
  });

  it("주문 보드는 활성 상태별로 그룹화되어 반환된다", async () => {
    const { orderId, pos } = await setupOrder();
    const board = await pos.get("/api/staff/pos/board");
    expect(board.status).toBe(200);
    expect(board.body.orders.NEW.some((o: { id: string }) => o.id === orderId)).toBe(true);
  });

  it("POS는 메뉴 품절 처리를 할 수 있고 감사 로그가 남는다", async () => {
    const { menuItem, pos } = await setupOrder();
    const res = await pos
      .patch(`/api/staff/pos/menu-items/${menuItem.id}/sold-out`)
      .set("X-BoardBite-Client", "1")
      .send({ isSoldOut: true });
    expect(res.status).toBe(200);
    expect(res.body.item.isSoldOut).toBe(true);

    const log = await prisma.auditLog.findFirst({ where: { targetId: menuItem.id, action: "MENU_SOLD_OUT" } });
    expect(log).not.toBeNull();
  });
});
