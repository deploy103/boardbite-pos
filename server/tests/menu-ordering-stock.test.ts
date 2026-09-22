import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import { createMenuItem, createStaff, loginAdmin, loginAgent, openTableAndJoin } from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

/**
 * 표시 순서 조정(메뉴 / 옵션 그룹 / 그룹 내 선택지)과
 * 재고 메뉴 연결을 통한 품절 자동 전파.
 */
describe("표시 순서 · 옵션 품절 전파", () => {
  async function seedTableCustomer(tableNumber: number) {
    const table = await prisma.table.create({ data: { number: tableNumber, publicSlug: `s${Date.now()}${tableNumber}` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);
    return { table, customer };
  }

  it("카테고리 안에서 메뉴 순서를 바꾸면 손님 화면 순서가 그대로 따라간다", async () => {
    const { agent: admin } = await loginAdmin();
    const category = await prisma.menuCategory.create({ data: { name: `순서_${Date.now()}` } });
    const a = await createMenuItem({ name: "가메뉴", price: 1000, categoryId: category.id });
    const b = await createMenuItem({ name: "나메뉴", price: 1000, categoryId: category.id });
    const c = await createMenuItem({ name: "다메뉴", price: 1000, categoryId: category.id });

    // 다 → 가 → 나 순서로 바꾼다.
    const res = await admin
      .post(`/api/staff/admin/menu/categories/${category.id}/reorder-items`)
      .set(...H)
      .send({ ids: [c.id, a.id, b.id] });
    expect(res.status).toBe(200);

    const { customer } = await seedTableCustomer(830001);
    const menu = await customer.get("/api/customer/menu").set(...H);
    const shown = (menu.body.categories as { id: string; items: { name: string }[] }[]).find((x) => x.id === category.id)!;
    expect(shown.items.map((i) => i.name)).toEqual(["다메뉴", "가메뉴", "나메뉴"]);

    // sortOrder는 0..n-1로 다시 매겨져 값이 겹치지 않는다.
    const stored = await prisma.menuItem.findMany({ where: { categoryId: category.id }, orderBy: { sortOrder: "asc" } });
    expect(stored.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("옵션 그룹과 그룹 내 선택지 순서를 바꾸면 손님 화면에 그대로 반영된다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "순서옵션메뉴", price: 3000 });

    const g1 = (await admin.post(`/api/staff/admin/menu/items/${item.id}/option-groups`).set(...H).send({ name: "먼저" })).body.group;
    const g2 = (await admin.post(`/api/staff/admin/menu/items/${item.id}/option-groups`).set(...H).send({ name: "나중" })).body.group;

    // 그룹 순서 뒤집기
    const gres = await admin
      .post(`/api/staff/admin/menu/items/${item.id}/reorder-option-groups`)
      .set(...H)
      .send({ ids: [g2.id, g1.id] });
    expect(gres.status).toBe(200);

    const c1 = (await admin.post(`/api/staff/admin/menu/option-groups/${g2.id}/choices`).set(...H).send({ name: "선택A" })).body.choice;
    const c2 = (await admin.post(`/api/staff/admin/menu/option-groups/${g2.id}/choices`).set(...H).send({ name: "선택B" })).body.choice;
    const c3 = (await admin.post(`/api/staff/admin/menu/option-groups/${g2.id}/choices`).set(...H).send({ name: "선택C" })).body.choice;

    // 선택지 순서: C → A → B
    const cres = await admin
      .post(`/api/staff/admin/menu/option-groups/${g2.id}/reorder-choices`)
      .set(...H)
      .send({ ids: [c3.id, c1.id, c2.id] });
    expect(cres.status).toBe(200);

    const { customer } = await seedTableCustomer(830002);
    const menu = await customer.get("/api/customer/menu").set(...H);
    const shown = (menu.body.categories as { items: { id: string; optionGroups: { name: string; choices: { name: string }[] }[] }[] }[])
      .flatMap((x) => x.items)
      .find((i) => i.id === item.id)!;
    expect(shown.optionGroups.map((g) => g.name)).toEqual(["나중", "먼저"]);
    expect(shown.optionGroups[0].choices.map((c) => c.name)).toEqual(["선택C", "선택A", "선택B"]);
  });

  it("목록이 그 사이에 바뀌었으면 정렬 요청을 거부한다(오래된 화면 제출 차단)", async () => {
    const { agent: admin } = await loginAdmin();
    const category = await prisma.menuCategory.create({ data: { name: `경합_${Date.now()}` } });
    const a = await createMenuItem({ name: "A", price: 100, categoryId: category.id });
    const b = await createMenuItem({ name: "B", price: 100, categoryId: category.id });
    const other = await createMenuItem({ name: "남의메뉴", price: 100 });

    // 다른 카테고리 메뉴를 끼워 넣기
    expect((await admin.post(`/api/staff/admin/menu/categories/${category.id}/reorder-items`).set(...H).send({ ids: [a.id, b.id, other.id] })).status).toBe(409);
    // 일부만 보내기
    expect((await admin.post(`/api/staff/admin/menu/categories/${category.id}/reorder-items`).set(...H).send({ ids: [a.id] })).status).toBe(409);
    // 중복
    expect((await admin.post(`/api/staff/admin/menu/categories/${category.id}/reorder-items`).set(...H).send({ ids: [a.id, a.id] })).status).toBe(400);
  });

  /** 공용 물품을 만들고 메뉴/옵션을 거기에 연결한다(요구사항 4.4의 관리자 작업과 같은 경로). */
  async function linkToInventory(
    admin: Awaited<ReturnType<typeof loginAgent>>,
    name: string,
    targets: { kind: "MENU_ITEM" | "OPTION_CHOICE"; id: string }[],
  ) {
    const created = await admin.post("/api/staff/admin/inventory").set(...H).send({ name });
    expect(created.status).toBe(201);
    const inventoryItemId = created.body.item.id as string;
    for (const target of targets) {
      const linked = await admin.post("/api/staff/admin/inventory/link").set(...H).send({ ...target, inventoryItemId });
      expect(linked.status).toBe(200);
    }
    return inventoryItemId;
  }

  it("4.1 공용 물품을 품절하면 그 물품을 쓰는 메뉴와 모든 옵션에 동시에 반영된다", async () => {
    const { agent: admin } = await loginAdmin();
    // 계란 메뉴 + 라면의 '계란 추가' + 우동의 '계란 추가'가 같은 물품을 공유한다.
    const egg = await createMenuItem({ name: "계란", price: 500 });
    const ramen = await createMenuItem({ name: "전파라면", price: 3000 });
    const udon = await createMenuItem({ name: "전파우동", price: 3000 });
    const mkChoice = async (menuId: string) => {
      const g = (await admin.post(`/api/staff/admin/menu/items/${menuId}/option-groups`).set(...H).send({ name: "추가 토핑", multiSelect: true })).body.group;
      const c = (await admin.post(`/api/staff/admin/menu/option-groups/${g.id}/choices`).set(...H).send({ name: "계란 추가", extraPrice: 500 })).body.choice;
      return c.id as string;
    };
    const ramenEgg = await mkChoice(ramen.id);
    const udonEgg = await mkChoice(udon.id);

    await linkToInventory(admin, "계란", [
      { kind: "MENU_ITEM", id: egg.id },
      { kind: "OPTION_CHOICE", id: ramenEgg },
      { kind: "OPTION_CHOICE", id: udonEgg },
    ]);

    // 메뉴 쪽에서 품절 처리한다.
    const res = await admin
      .post("/api/staff/admin/inventory/sold-out")
      .set(...H)
      .send({ targets: [{ kind: "MENU_ITEM", id: egg.id }], soldOut: true });
    expect(res.status).toBe(200);

    const { customer } = await seedTableCustomer(831001);
    const menu = await customer.get("/api/customer/menu").set(...H);
    const items = (menu.body.categories as { items: { id: string; isSoldOut: boolean; optionGroups: { choices: { id: string; isSoldOut: boolean }[] }[] }[] }[]).flatMap((c) => c.items);
    // 계란 메뉴도, 두 메뉴의 계란 추가 옵션도 전부 품절이다.
    expect(items.find((i) => i.id === egg.id)!.isSoldOut).toBe(true);
    for (const [menuId, choiceId] of [[ramen.id, ramenEgg], [udon.id, udonEgg]] as const) {
      const choice = items.find((i) => i.id === menuId)!.optionGroups[0].choices.find((c) => c.id === choiceId)!;
      expect(choice.isSoldOut).toBe(true);
    }

    // 주문도 양쪽 다 거부된다.
    for (const [menuId, choiceId] of [[ramen.id, ramenEgg], [udon.id, udonEgg]] as const) {
      const blocked = await customer
        .post("/api/customer/orders")
        .set(...H)
        .send({ idempotencyKey: `b-${choiceId}-${Date.now()}`, items: [{ menuItemId: menuId, quantity: 1, optionChoiceIds: [choiceId] }] });
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe("OPTION_SOLD_OUT");
    }
    const eggBlocked = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `egg-${Date.now()}`, items: [{ menuItemId: egg.id, quantity: 1, optionChoiceIds: [] }] });
    expect(eggBlocked.body.code).toBe("MENU_SOLD_OUT");
  });

  it("4.2 옵션 쪽에서 품절해도 같은 물품의 메뉴와 다른 옵션에 반영된다(양방향)", async () => {
    const { agent: admin } = await loginAdmin();
    const egg = await createMenuItem({ name: "양방향계란", price: 500 });
    const ramen = await createMenuItem({ name: "양방향라면", price: 3000 });
    const g = (await admin.post(`/api/staff/admin/menu/items/${ramen.id}/option-groups`).set(...H).send({ name: "토핑", multiSelect: true })).body.group;
    const choice = (await admin.post(`/api/staff/admin/menu/option-groups/${g.id}/choices`).set(...H).send({ name: "계란 추가", extraPrice: 500 })).body.choice;
    await linkToInventory(admin, "양방향계란", [
      { kind: "MENU_ITEM", id: egg.id },
      { kind: "OPTION_CHOICE", id: choice.id },
    ]);

    // **옵션 쪽**에서 품절 처리한다.
    await admin.post("/api/staff/admin/inventory/sold-out").set(...H).send({ targets: [{ kind: "OPTION_CHOICE", id: choice.id }], soldOut: true });

    const { customer } = await seedTableCustomer(831002);
    const menu = await customer.get("/api/customer/menu").set(...H);
    const items = (menu.body.categories as { items: { id: string; isSoldOut: boolean }[] }[]).flatMap((c) => c.items);
    // 글로벌 메뉴에도 반영된다.
    expect(items.find((i) => i.id === egg.id)!.isSoldOut).toBe(true);

    // 판매 재개도 양방향으로 동작한다.
    await admin.post("/api/staff/admin/inventory/sold-out").set(...H).send({ targets: [{ kind: "MENU_ITEM", id: egg.id }], soldOut: false });
    const after = await customer.get("/api/customer/menu").set(...H);
    const afterItems = (after.body.categories as { items: { id: string; isSoldOut: boolean; optionGroups: { choices: { isSoldOut: boolean }[] }[] }[] }[]).flatMap((c) => c.items);
    expect(afterItems.find((i) => i.id === egg.id)!.isSoldOut).toBe(false);
    expect(afterItems.find((i) => i.id === ramen.id)!.optionGroups[0].choices[0].isSoldOut).toBe(false);
  });

  it("4.3 옵션에만 있는 독립 품목도 품절할 수 있고 다른 항목에는 영향이 없다", async () => {
    const { agent: admin } = await loginAdmin();
    const udon = await createMenuItem({ name: "독립우동", price: 3000 });
    const other = await createMenuItem({ name: "무관메뉴2", price: 1000 });
    const g = (await admin.post(`/api/staff/admin/menu/items/${udon.id}/option-groups`).set(...H).send({ name: "요청", multiSelect: true })).body.group;
    const scallion = (await admin.post(`/api/staff/admin/menu/option-groups/${g.id}/choices`).set(...H).send({ name: "쪽파 추가", extraPrice: 0 })).body.choice;

    // 글로벌 메뉴로 존재하지 않는 품목이지만 품절 처리가 된다.
    const res = await admin
      .post("/api/staff/admin/inventory/sold-out")
      .set(...H)
      .send({ targets: [{ kind: "OPTION_CHOICE", id: scallion.id }], soldOut: true });
    expect(res.status).toBe(200);

    const { customer } = await seedTableCustomer(831003);
    const blocked = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `sc-${Date.now()}`, items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [scallion.id] }] });
    expect(blocked.status).toBe(400);

    // 다른 메뉴는 멀쩡하다.
    const ok = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `ot-${Date.now()}`, items: [{ menuItemId: other.id, quantity: 1, optionChoiceIds: [] }] });
    expect(ok.status).toBe(201);

    // 나중에 공용 물품으로 승격해 다른 항목과 연결할 수 있다.
    const created = await admin.post("/api/staff/admin/inventory").set(...H).send({ name: "쪽파" });
    const linked = await admin
      .post("/api/staff/admin/inventory/link")
      .set(...H)
      .send({ kind: "OPTION_CHOICE", id: scallion.id, inventoryItemId: created.body.item.id });
    expect(linked.status).toBe(200);
    // 연결해도 품절 상태가 유지된다(자체 플래그를 물품이 물려받는 것이 아니라, 연결 시점엔 물품이 기준).
    const impact = await admin.post("/api/staff/admin/inventory/impact").set(...H).send({ targets: [{ kind: "OPTION_CHOICE", id: scallion.id }] });
    expect(impact.body.impact[0].inventoryItem.name).toBe("쪽파");
  });

  it("4.4 연결 해제 시 물품의 품절 상태를 물려받고, 사용 중인 물품은 삭제되지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "해제확인메뉴", price: 1000 });
    const inventoryItemId = await linkToInventory(admin, "해제확인물품", [{ kind: "MENU_ITEM", id: item.id }]);
    await admin.post("/api/staff/admin/inventory/sold-out").set(...H).send({ targets: [{ kind: "MENU_ITEM", id: item.id }], soldOut: true });

    // 사용 중이면 삭제되지 않는다.
    const blockedDelete = await admin.delete(`/api/staff/admin/inventory/${inventoryItemId}`).set(...H);
    expect(blockedDelete.status).toBe(409);
    expect(blockedDelete.body.code).toBe("INVENTORY_IN_USE");

    // 연결을 끊으면 품절 상태를 물려받는다 — 갑자기 판매 재개되지 않는다.
    await admin.post("/api/staff/admin/inventory/link").set(...H).send({ kind: "MENU_ITEM", id: item.id, inventoryItemId: null });
    const stored = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.inventoryItemId).toBeNull();
    expect(stored.isSoldOut).toBe(true);

    // 이제 삭제된다(논리 삭제).
    const ok = await admin.delete(`/api/staff/admin/inventory/${inventoryItemId}`).set(...H);
    expect(ok.status).toBe(200);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId } })).deletedAt).not.toBeNull();
  });

  it("필수 그룹의 선택지가 전부 품절이면 그 메뉴는 판매 불가로 표시되고 주문도 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const ramen = await createMenuItem({ name: "필수품절라면2", price: 3000 });
    const group = (await admin.post(`/api/staff/admin/menu/items/${ramen.id}/option-groups`).set(...H).send({ name: "종류", required: true })).body.group;
    const only = (await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "유일선택" })).body.choice;
    await admin.post("/api/staff/admin/inventory/sold-out").set(...H).send({ targets: [{ kind: "OPTION_CHOICE", id: only.id }], soldOut: true });

    const adminMenu = await admin.get("/api/staff/admin/menu/categories").set(...H);
    const shown = (adminMenu.body.categories as { items: { id: string; blockedRequiredGroups: string[] }[] }[])
      .flatMap((c) => c.items)
      .find((i) => i.id === ramen.id)!;
    expect(shown.blockedRequiredGroups).toContain("종류");

    const { customer } = await seedTableCustomer(831005);
    const res = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `allsold2-${Date.now()}`, items: [{ menuItemId: ramen.id, quantity: 1, optionChoiceIds: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("품절");
  });

  it("FRONT 현장 결제에서도 품절 옵션은 견적/확정이 거부되고 메뉴에 품절이 실린다", async () => {
    const { agent: admin } = await loginAdmin();
    const { createStaff: mkStaff, loginAgent: login } = await import("./helpers.js");
    const { username, password } = await mkStaff("FRONT");
    const front = await login(username, password);

    const main = await createMenuItem({ name: "현장품절확인2", price: 2000, channel: "FRONT", needsCooking: false, showInKitchen: false });
    const group = (await admin.post(`/api/staff/admin/menu/items/${main.id}/option-groups`).set(...H).send({ name: "토핑", multiSelect: true })).body.group;
    const choice = (await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "추가", extraPrice: 300 })).body.choice;
    await admin.post("/api/staff/admin/inventory/sold-out").set(...H).send({ targets: [{ kind: "OPTION_CHOICE", id: choice.id }], soldOut: true });

    const cart = { items: [{ menuItemId: main.id, quantity: 1, optionChoiceIds: [choice.id] }] };
    expect((await front.post("/api/staff/front/counter/quote").set(...H).send(cart)).status).toBe(400);
    expect(
      (await front.post("/api/staff/front/counter/confirm").set(...H).send({ ...cart, idempotencyKey: `so2-${Date.now()}`, methodCode: "CARD" })).status,
    ).toBe(400);

    const menu = await front.get("/api/staff/front/counter/menu").set(...H);
    const shown = (menu.body.categories as { items: { id: string; optionGroups: { choices: { isSoldOut: boolean }[] }[] }[] }[])
      .flatMap((c) => c.items)
      .find((i) => i.id === main.id)!;
    expect(shown.optionGroups[0].choices[0].isSoldOut).toBe(true);
  });

  it("권한 없는 역할은 품절/판매 재개를 할 수 없다", async () => {
    const item = await createMenuItem({ name: "권한품절", price: 1000 });
    const body = { targets: [{ kind: "MENU_ITEM", id: item.id }], soldOut: true };
    for (const role of ["SERVING"] as const) {
      const { username, password } = await createStaff(role);
      const agent = await loginAgent(username, password);
      expect((await agent.post("/api/staff/admin/inventory/sold-out").set(...H).send(body)).status).toBe(403);
      expect((await agent.post("/api/staff/pos/sold-out").set(...H).send(body)).status).toBe(403);
    }
    // 비로그인
    const { default: request } = await import("supertest");
    const { app } = await import("./helpers.js");
    expect((await request(app).post("/api/staff/admin/inventory/sold-out").set(...H).send(body)).status).toBe(401);
  });

  it("같은 물품을 동시에 품절 처리해도 마지막 상태가 일관된다", async () => {
    const { agent: admin } = await loginAdmin();
    const a = await createMenuItem({ name: "동시품절A", price: 1000 });
    const b = await createMenuItem({ name: "동시품절B", price: 1000 });
    const inventoryItemId = await linkToInventory(admin, "동시물품", [
      { kind: "MENU_ITEM", id: a.id },
      { kind: "MENU_ITEM", id: b.id },
    ]);

    const results = await Promise.all([
      admin.post("/api/staff/admin/inventory/sold-out").set(...H).send({ targets: [{ kind: "MENU_ITEM", id: a.id }], soldOut: true }),
      admin.post("/api/staff/admin/inventory/sold-out").set(...H).send({ targets: [{ kind: "MENU_ITEM", id: b.id }], soldOut: true }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // 두 요청이 같은 물품을 건드렸고 최종 상태는 품절 하나로 일관된다.
    const stored = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId } });
    expect(stored.isSoldOut).toBe(true);
    expect(stored.soldOutAt).not.toBeNull();
    // 두 메뉴 모두 품절로 보인다(각자 플래그를 복사하지 않으므로 어긋날 수 없다).
    const items = await prisma.menuItem.findMany({ where: { id: { in: [a.id, b.id] } }, include: { inventoryItem: true } });
    expect(items.every((i) => i.inventoryItem!.isSoldOut)).toBe(true);
  });
});
