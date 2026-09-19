import { describe, it, expect } from "vitest";
import request from "supertest";
import { createStaff, loginAgent, createTableWithMenu, openTableSessionDirect, createOrderWithItem, joinCustomer } from "./helpers.js";
import { prisma } from "../src/prisma.js";

describe("SERVING", () => {
  async function setupReadyOrder() {
    const { table, menuItem } = await createTableWithMenu();
    const front = await createStaff("FRONT");
    const session = await openTableSessionDirect(table.id, front.username);
    const { order } = await createOrderWithItem(session.id, menuItem.id, 6000, 1, "READY");
    const serving = await loginAgent((await createStaff("SERVING")).username, "testpass1234");
    return { order, serving, session };
  }

  it("READY 주문 목록을 조회하고 서빙완료 처리할 수 있다", async () => {
    const { order, serving } = await setupReadyOrder();

    const list = await serving.get("/api/staff/serving/ready");
    expect(list.status).toBe(200);
    expect(list.body.orders.some((o: { id: string }) => o.id === order.id)).toBe(true);

    const res = await serving.post(`/api/staff/serving/orders/${order.id}/served`).set("X-BoardBite-Client", "1").send();
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("SERVED");
  });

  it("서빙완료 직후(허용 시간 이내)에는 일반 SERVING 계정도 되돌릴 수 있다", async () => {
    const { order, serving } = await setupReadyOrder();
    await serving.post(`/api/staff/serving/orders/${order.id}/served`).set("X-BoardBite-Client", "1").send();

    const revert = await serving.post(`/api/staff/serving/orders/${order.id}/revert`).set("X-BoardBite-Client", "1").send();
    expect(revert.status).toBe(200);
    expect(revert.body.order.status).toBe("READY");
  });

  it("허용 시간이 지나면 일반 SERVING 계정은 되돌릴 수 없지만 ADMIN은 가능하다", async () => {
    const { order, serving } = await setupReadyOrder();
    await serving.post(`/api/staff/serving/orders/${order.id}/served`).set("X-BoardBite-Client", "1").send();

    // 허용 시간(기본 180초)을 훨씬 지난 것처럼 servedAt을 과거로 조작한다.
    await prisma.order.update({ where: { id: order.id }, data: { servedAt: new Date(Date.now() - 10 * 60 * 1000) } });

    const tooLate = await serving.post(`/api/staff/serving/orders/${order.id}/revert`).set("X-BoardBite-Client", "1").send();
    expect(tooLate.status).toBe(403);

    const admin = await loginAgent((await createStaff("ADMIN")).username, "testpass1234");
    const adminRevert = await admin.post(`/api/staff/serving/orders/${order.id}/revert`).set("X-BoardBite-Client", "1").send();
    expect(adminRevert.status).toBe(200);
    expect(adminRevert.body.order.status).toBe("READY");
  });

  it("FRONT 계정은 SERVING API를 호출할 수 없다", async () => {
    const { order } = await setupReadyOrder();
    const front = await loginAgent((await createStaff("FRONT")).username, "testpass1234");
    const res = await front.post(`/api/staff/serving/orders/${order.id}/served`).set("X-BoardBite-Client", "1").send();
    expect(res.status).toBe(403);
  });

  it("READY가 아닌 주문은 서빙완료 처리할 수 없다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const front = await createStaff("FRONT");
    const session = await openTableSessionDirect(table.id, front.username);
    const { order } = await createOrderWithItem(session.id, menuItem.id, 6000, 1, "PREPARING");
    const serving = await loginAgent((await createStaff("SERVING")).username, "testpass1234");

    const res = await serving.post(`/api/staff/serving/orders/${order.id}/served`).set("X-BoardBite-Client", "1").send();
    expect(res.status).toBe(409);
  });
});

describe("직원 호출", () => {
  async function setupCustomerSession() {
    const { table } = await createTableWithMenu();
    const front = await createStaff("FRONT");
    const session = await openTableSessionDirect(table.id, front.username);
    const customer = await joinCustomer(table.publicSlug, session.joinCode);
    return { customer, session };
  }

  it("고객이 직원을 호출하면 SERVING 목록에 나타나고, 확인/완료 처리를 할 수 있다", async () => {
    const { customer } = await setupCustomerSession();
    const callRes = await customer.post("/api/customer/staff-call").set("X-BoardBite-Client", "1").send();
    expect(callRes.status).toBe(201);

    const serving = await loginAgent((await createStaff("SERVING")).username, "testpass1234");
    const list = await serving.get("/api/staff/serving/staff-calls");
    expect(list.body.calls.some((c: { id: string }) => c.id === callRes.body.call.id)).toBe(true);

    const ack = await serving.post(`/api/staff/serving/staff-calls/${callRes.body.call.id}/ack`).set("X-BoardBite-Client", "1").send();
    expect(ack.status).toBe(200);
    expect(ack.body.call.status).toBe("ACKED");

    const done = await serving.post(`/api/staff/serving/staff-calls/${callRes.body.call.id}/done`).set("X-BoardBite-Client", "1").send();
    expect(done.status).toBe(200);
    expect(done.body.call.status).toBe("DONE");
  });

  it("이미 대기 중인 호출이 있으면 중복 생성하지 않는다", async () => {
    const { customer } = await setupCustomerSession();
    const first = await customer.post("/api/customer/staff-call").set("X-BoardBite-Client", "1").send();
    const second = await customer.post("/api/customer/staff-call").set("X-BoardBite-Client", "1").send();
    expect(first.body.call.id).toBe(second.body.call.id);

    const count = await prisma.staffCallRequest.count();
    // 이 테스트 케이스에서 생성된 호출은 1건이어야 한다(다른 테스트의 호출과는 tableSessionId로 구분됨).
    const forThisSession = await prisma.staffCallRequest.findMany({ where: { tableSessionId: first.body.call.tableSessionId } });
    expect(forThisSession).toHaveLength(1);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
