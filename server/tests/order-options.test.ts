import { describe, it, expect } from "vitest";
import {
  createStaff,
  loginAgent,
  createBareTable,
  createMenuItemWithOptions,
  openTableAndJoin,
} from "./helpers.js";
import { prisma } from "../src/prisma.js";

/**
 * 요구사항2.md §3.3 — 메뉴 옵션 규칙을 서버에서도 전부 검증한다.
 * 모든 케이스는 클라이언트 UI를 거치지 않고 API를 직접 호출한다.
 */
async function setup() {
  const table = await createBareTable();
  const menu = await createMenuItemWithOptions();
  const { username, password } = await createStaff("FRONT");
  const front = await loginAgent(username, password);
  const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);
  return { customer, menu };
}

function orderBody(menuItemId: string, optionChoiceIds: string[], key: string) {
  return { idempotencyKey: key, items: [{ menuItemId, quantity: 1, optionChoiceIds }] };
}

describe("주문 옵션 서버 검증", () => {
  it("required 그룹을 선택하지 않으면 주문이 거부된다", async () => {
    const { customer, menu } = await setup();
    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(orderBody(menu.menuItem.id, [], "missing-required"));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("사이즈");
  });

  it("multiSelect=false 그룹에서 두 개를 고르면 거부된다", async () => {
    const { customer, menu } = await setup();
    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(orderBody(menu.menuItem.id, [menu.small.id, menu.large.id], "multi-single"));
    expect(res.status).toBe(400);
  });

  it("같은 choice를 중복해서 보내면 거부된다", async () => {
    const { customer, menu } = await setup();
    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(orderBody(menu.menuItem.id, [menu.small.id, menu.small.id], "dup-choice"));
    expect(res.status).toBe(400);
  });

  it("비활성 choice는 선택할 수 없다", async () => {
    const { customer, menu } = await setup();
    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(orderBody(menu.menuItem.id, [menu.small.id, menu.inactive.id], "inactive-choice"));
    expect(res.status).toBe(400);
  });

  it("다른 메뉴의 옵션은 선택할 수 없다", async () => {
    const { customer, menu } = await setup();
    const otherMenu = await createMenuItemWithOptions();
    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(orderBody(menu.menuItem.id, [otherMenu.small.id], "foreign-choice"));
    expect(res.status).toBe(400);
  });

  it("존재하지 않는 optionChoiceId는 거부된다", async () => {
    const { customer, menu } = await setup();
    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(orderBody(menu.menuItem.id, ["no-such-choice-id"], "ghost-choice"));
    expect(res.status).toBe(400);
  });

  it("규칙을 지킨 주문은 옵션 추가금이 서버 기준으로 스냅샷된다", async () => {
    const { customer, menu } = await setup();
    const res = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(orderBody(menu.menuItem.id, [menu.large.id, menu.cheese.id], "valid-order"));
    expect(res.status).toBe(201);

    const item = res.body.order.items[0];
    expect(item.unitPrice).toBe(6000);
    const extras = item.options.reduce((sum: number, o: { extraPriceSnapshot: number }) => sum + o.extraPriceSnapshot, 0);
    expect(extras).toBe(1500);

    // 청구 금액도 옵션을 포함해 계산되어야 한다(화면 표시와 동일한 기준 — §10.1).
    const bill = await customer.get("/api/customer/session");
    expect(bill.body.bill.totalAmount).toBe(7500);
  });
});

describe("옵션 가격 정책", () => {
  it("관리자는 음수 추가금 옵션을 만들 수 없다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);
    const menu = await createMenuItemWithOptions();

    const res = await admin
      .post(`/api/staff/admin/menu/option-groups/${menu.optionalMulti.id}/choices`)
      .set("X-BoardBite-Client", "1")
      .send({ name: "마이너스", extraPrice: -1000 });
    expect(res.status).toBe(400);

    const created = await prisma.optionChoice.findFirst({ where: { name: "마이너스" } });
    expect(created).toBeNull();
  });
});
