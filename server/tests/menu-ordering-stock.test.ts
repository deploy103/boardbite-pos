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

  it("연결한 재고 메뉴를 품절 처리하면 옵션도 자동으로 품절이 되고 주문이 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const egg = await createMenuItem({ name: "계란", price: 500 });
    const udon = await createMenuItem({ name: "품절전파우동", price: 3000 });
    const group = (await admin.post(`/api/staff/admin/menu/items/${udon.id}/option-groups`).set(...H).send({ name: "추가 토핑", multiSelect: true })).body.group;
    const choice = (await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "계란 추가", extraPrice: 500 })).body.choice;

    // 계란 메뉴를 재고로 연결한다.
    const linked = await admin
      .post(`/api/staff/admin/menu/option-groups/${group.id}/choices/${choice.id}/stock-link`)
      .set(...H)
      .send({ linkedMenuItemId: egg.id });
    expect(linked.status).toBe(200);

    const { customer } = await seedTableCustomer(830003);
    const readChoice = async () => {
      const menu = await customer.get("/api/customer/menu").set(...H);
      return (menu.body.categories as { items: { id: string; optionGroups: { choices: { id: string; isSoldOut: boolean; soldOutReason: string | null }[] }[] }[] }[])
        .flatMap((x) => x.items)
        .find((i) => i.id === udon.id)!
        .optionGroups[0].choices[0];
    };

    // 품절 전: 고를 수 있다.
    expect((await readChoice()).isSoldOut).toBe(false);
    const ok = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `before-${Date.now()}`, items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [choice.id] }] });
    expect(ok.status).toBe(201);

    // 계란을 품절 처리한다.
    await admin.patch(`/api/staff/admin/menu/items/${egg.id}`).set(...H).send({ isSoldOut: true });

    // 옵션이 자동으로 품절이 되고 이유까지 내려온다(감춰지지 않고 보인다).
    const after = await readChoice();
    expect(after.isSoldOut).toBe(true);
    expect(after.soldOutReason).toBe("계란");

    // 품절 옵션을 담은 주문은 서버가 거부한다.
    const blocked = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `after-${Date.now()}`, items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [choice.id] }] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toContain("품절");

    // 옵션을 빼면 정상 주문된다 — 메뉴 자체가 막히는 건 아니다.
    const withoutOption = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `plain-${Date.now()}`, items: [{ menuItemId: udon.id, quantity: 1, optionChoiceIds: [] }] });
    expect(withoutOption.status).toBe(201);

    // 품절을 풀면 다시 고를 수 있다.
    await admin.patch(`/api/staff/admin/menu/items/${egg.id}`).set(...H).send({ isSoldOut: false });
    expect((await readChoice()).isSoldOut).toBe(false);
  });

  it("연결 메뉴를 삭제하거나 판매 중지해도 옵션이 품절로 막힌다", async () => {
    const { agent: admin } = await loginAdmin();
    const stock = await createMenuItem({ name: "재고품목", price: 500 });
    const main = await createMenuItem({ name: "연결확인메뉴", price: 2000 });
    const group = (await admin.post(`/api/staff/admin/menu/items/${main.id}/option-groups`).set(...H).send({ name: "토핑", multiSelect: true })).body.group;
    const choice = (await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "추가", extraPrice: 300 })).body.choice;
    await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices/${choice.id}/stock-link`).set(...H).send({ linkedMenuItemId: stock.id });

    // 판매 중지(isActive=false)만으로도 품절 취급된다.
    await admin.patch(`/api/staff/admin/menu/items/${stock.id}`).set(...H).send({ isActive: false });
    const { customer } = await seedTableCustomer(830004);
    const blocked = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `inactive-${Date.now()}`, items: [{ menuItemId: main.id, quantity: 1, optionChoiceIds: [choice.id] }] });
    expect(blocked.status).toBe(400);
  });

  it("필수 그룹의 선택지가 전부 품절이면 그 메뉴는 판매 불가로 표시되고 주문도 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const stock = await createMenuItem({ name: "유일재고", price: 500 });
    const ramen = await createMenuItem({ name: "필수품절라면", price: 3000 });
    const group = (await admin.post(`/api/staff/admin/menu/items/${ramen.id}/option-groups`).set(...H).send({ name: "종류", required: true })).body.group;
    const only = (await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "유일선택" })).body.choice;
    await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices/${only.id}/stock-link`).set(...H).send({ linkedMenuItemId: stock.id });

    await admin.patch(`/api/staff/admin/menu/items/${stock.id}`).set(...H).send({ isSoldOut: true });

    // 관리자 화면이 판매 불가로 경고한다.
    const adminMenu = await admin.get("/api/staff/admin/menu/categories").set(...H);
    const shown = (adminMenu.body.categories as { items: { id: string; blockedRequiredGroups: string[] }[] }[])
      .flatMap((c) => c.items)
      .find((i) => i.id === ramen.id)!;
    expect(shown.blockedRequiredGroups).toContain("종류");

    // 서버도 주문을 거부한다.
    const { customer } = await seedTableCustomer(830005);
    const res = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `allsold-${Date.now()}`, items: [{ menuItemId: ramen.id, quantity: 1, optionChoiceIds: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("품절");
  });

  it("연결하지 않은 선택지는 다른 메뉴가 품절돼도 영향받지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const unrelated = await createMenuItem({ name: "무관메뉴", price: 500 });
    const main = await createMenuItem({ name: "무관확인메뉴", price: 2000 });
    const group = (await admin.post(`/api/staff/admin/menu/items/${main.id}/option-groups`).set(...H).send({ name: "토핑", multiSelect: true })).body.group;
    const choice = (await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "연결없음", extraPrice: 100 })).body.choice;

    await admin.patch(`/api/staff/admin/menu/items/${unrelated.id}`).set(...H).send({ isSoldOut: true });

    const { customer } = await seedTableCustomer(830006);
    const res = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: `nolink-${Date.now()}`, items: [{ menuItemId: main.id, quantity: 1, optionChoiceIds: [choice.id] }] });
    expect(res.status).toBe(201);
  });

  it("FRONT 현장 결제에서도 품절 옵션은 견적/확정이 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const { createStaff: mkStaff, loginAgent: login } = await import("./helpers.js");
    const { username, password } = await mkStaff("FRONT");
    const front = await login(username, password);

    const stock = await createMenuItem({ name: "현장재고", price: 500, channel: "FRONT" });
    const main = await createMenuItem({ name: "현장품절확인", price: 2000, channel: "FRONT", needsCooking: false, showInKitchen: false });
    const group = (await admin.post(`/api/staff/admin/menu/items/${main.id}/option-groups`).set(...H).send({ name: "토핑", multiSelect: true })).body.group;
    const choice = (await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "추가", extraPrice: 300 })).body.choice;
    await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices/${choice.id}/stock-link`).set(...H).send({ linkedMenuItemId: stock.id });
    await admin.patch(`/api/staff/admin/menu/items/${stock.id}`).set(...H).send({ isSoldOut: true });

    const cart = { items: [{ menuItemId: main.id, quantity: 1, optionChoiceIds: [choice.id] }] };
    expect((await front.post("/api/staff/front/counter/quote").set(...H).send(cart)).status).toBe(400);
    expect(
      (await front.post("/api/staff/front/counter/confirm").set(...H).send({ ...cart, idempotencyKey: `so-${Date.now()}`, methodCode: "CARD" })).status,
    ).toBe(400);

    // FRONT 메뉴 응답에도 품절 상태가 실린다.
    const menu = await front.get("/api/staff/front/counter/menu").set(...H);
    const shown = (menu.body.categories as { items: { id: string; optionGroups: { choices: { isSoldOut: boolean }[] }[] }[] }[])
      .flatMap((c) => c.items)
      .find((i) => i.id === main.id)!;
    expect(shown.optionGroups[0].choices[0].isSoldOut).toBe(true);
  });
});
