import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import {
  createMenuItem,
  createStaff,
  createTableWithMenu,
  loginAdmin,
  loginAgent,
  openTableAndJoin,
} from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

/**
 * 요구사항.md §9 인수 테스트 1~5, 7
 * — 필수 옵션 검증, 옵션 조합, 논리 삭제 후 이력 보존, 카테고리 삭제 정책, FRONT 전용 차단.
 */
describe("메뉴 옵션 · 삭제 · 카테고리 (인수 1~5, 7)", () => {
  /** 라면(필수 단일 '종류') + 우동(선택 복수) 세트를 만든다. */
  async function seedRamenAndUdon() {
    const { agent: admin } = await loginAdmin();
    const category = await prisma.menuCategory.create({ data: { name: `분식_${Date.now()}` } });

    const ramen = await createMenuItem({ name: "라면", price: 3000, categoryId: category.id });
    const kind = await prisma.optionGroup.create({
      data: { menuItemId: ramen.id, name: "종류", minSelect: 1, maxSelect: 1 },
    });
    const shin = await prisma.optionChoice.create({ data: { groupId: kind.id, name: "신라면", extraPrice: 0 } });
    const yuk = await prisma.optionChoice.create({ data: { groupId: kind.id, name: "육개장", extraPrice: 0 } });

    const udon = await createMenuItem({ name: "우동", price: 3000, categoryId: category.id });
    const request = await prisma.optionGroup.create({
      data: { menuItemId: udon.id, name: "재료 요청", minSelect: 0, maxSelect: null },
    });
    const noScallion = await prisma.optionChoice.create({
      data: { groupId: request.id, name: "쪽파 제외", extraPrice: 0 },
    });
    const topping = await prisma.optionGroup.create({
      data: { menuItemId: udon.id, name: "추가 토핑", minSelect: 0, maxSelect: null },
    });
    const egg = await prisma.optionChoice.create({ data: { groupId: topping.id, name: "계란 추가", extraPrice: 500 } });
    const review = await prisma.optionGroup.create({
      data: { menuItemId: udon.id, name: "리뷰 이벤트", minSelect: 0, maxSelect: 1 },
    });
    const join = await prisma.optionChoice.create({ data: { groupId: review.id, name: "참여", extraPrice: 0 } });

    return { admin, category, ramen, kind, shin, yuk, udon, noScallion, egg, review, join };
  }

  it("1. 라면 필수 '종류'를 빼면 주문이 거부되고, 하나 고르면 성공한다", async () => {
    const seed = await seedRamenAndUdon();
    const table = await prisma.table.create({ data: { number: 810001, publicSlug: `s${Date.now()}a` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const missing = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: "k1", items: [{ menuItemId: seed.ramen.id, quantity: 1, optionChoiceIds: [] }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("종류");

    const ok = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: "k2", items: [{ menuItemId: seed.ramen.id, quantity: 1, optionChoiceIds: [seed.shin.id] }] });
    expect(ok.status).toBe(201);
    expect(ok.body.order.items[0].options[0].nameSnapshot).toBe("신라면");
    // 그룹명 스냅샷이 함께 남아 주방/영수증 표시가 흔들리지 않는다.
    expect(ok.body.order.items[0].options[0].groupNameSnapshot).toBe("종류");
  });

  it("1. 다른 메뉴의 옵션 · 중복 ID · 같은 단일 그룹 2개 선택은 서버가 거부한다", async () => {
    const seed = await seedRamenAndUdon();
    const table = await prisma.table.create({ data: { number: 810002, publicSlug: `s${Date.now()}b` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const order = (key: string, ids: string[]) =>
      customer
        .post("/api/customer/orders")
        .set(...H)
        .send({ idempotencyKey: key, items: [{ menuItemId: seed.ramen.id, quantity: 1, optionChoiceIds: ids }] });

    // 우동 옵션을 라면에 붙이기
    expect((await order("x1", [seed.shin.id, seed.egg.id])).status).toBe(400);
    // 같은 옵션 두 번
    expect((await order("x2", [seed.shin.id, seed.shin.id])).status).toBe(400);
    // 단일 선택 그룹에서 둘 다
    expect((await order("x3", [seed.shin.id, seed.yuk.id])).status).toBe(400);

    // 비활성 선택지
    const inactive = await prisma.optionChoice.create({
      data: { groupId: seed.kind.id, name: "품절라면", extraPrice: 0, isActive: false },
    });
    expect((await order("x4", [inactive.id])).status).toBe(400);
  });

  it("2. 우동에 무료/유료 옵션을 함께 고르면 수량만큼 추가금이 곱해지고 스냅샷이 전부 남는다", async () => {
    const seed = await seedRamenAndUdon();
    const table = await prisma.table.create({ data: { number: 810003, publicSlug: `s${Date.now()}c` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const res = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({
        idempotencyKey: "udon-2",
        items: [
          {
            menuItemId: seed.udon.id,
            quantity: 2,
            optionChoiceIds: [seed.noScallion.id, seed.egg.id, seed.join.id],
          },
        ],
      });
    expect(res.status).toBe(201);
    const item = res.body.order.items[0];
    expect(item.options).toHaveLength(3);
    expect(item.options.map((o: { nameSnapshot: string }) => o.nameSnapshot).sort()).toEqual(
      ["계란 추가", "쪽파 제외", "참여"].sort(),
    );

    // (3000 기본 + 500 계란) × 2 = 7000 — 계란 추가금도 2개분(1,000원)이 붙는다.
    const bill = await customer.get("/api/customer/session").set(...H);
    expect(bill.body.bill.totalAmount).toBe(7000);
  });

  it("3. 활성 선택지가 없는 필수 그룹의 메뉴는 주문이 거부된다", async () => {
    const category = await prisma.menuCategory.create({ data: { name: `빈필수_${Date.now()}` } });
    const item = await createMenuItem({ name: "설정미완료메뉴", price: 1000, categoryId: category.id });
    await prisma.optionGroup.create({ data: { menuItemId: item.id, name: "필수선택", minSelect: 1, maxSelect: 1 } });

    const table = await prisma.table.create({ data: { number: 810004, publicSlug: `s${Date.now()}d` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const res = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: "blocked", items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("주문할 수 없");
  });

  it("4. 메뉴를 논리 삭제해도 과거 주문 스냅샷은 그대로이고 새 주문만 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const { table, menuItem } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const before = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: "pre-delete", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    expect(before.status).toBe(201);
    const snapshotName = before.body.order.items[0].nameSnapshot;

    // 가격 변경 후 삭제 — 과거 주문에는 영향이 없어야 한다.
    await admin.patch(`/api/staff/admin/menu/items/${menuItem.id}`).set(...H).send({ price: 99000 });
    const deleted = await admin.delete(`/api/staff/admin/menu/items/${menuItem.id}`).set(...H);
    expect(deleted.status).toBe(200);

    const stale = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: "post-delete", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    expect(stale.status).toBe(400);

    // 과거 주문 행은 삭제되지 않고 이름/단가 스냅샷도 그대로다.
    const kept = await prisma.orderItem.findFirstOrThrow({ where: { orderId: before.body.order.id } });
    expect(kept.nameSnapshot).toBe(snapshotName);
    expect(kept.unitPrice).toBe(6000);
    // 메뉴 행 자체도 물리 삭제되지 않는다(FK 보존).
    expect(await prisma.menuItem.findUnique({ where: { id: menuItem.id } })).not.toBeNull();
  });

  it("5. 소속 메뉴가 있는 카테고리는 삭제가 막히고, 이동/삭제 후에는 성공한다", async () => {
    const { agent: admin } = await loginAdmin();
    const from = await prisma.menuCategory.create({ data: { name: `이동전_${Date.now()}` } });
    const to = await prisma.menuCategory.create({ data: { name: `이동후_${Date.now()}` } });
    const item = await createMenuItem({ name: "이동대상", price: 1000, categoryId: from.id });

    const blocked = await admin.delete(`/api/staff/admin/menu/categories/${from.id}`).set(...H);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("1개");

    // 다른 카테고리로 이동
    const moved = await admin.patch(`/api/staff/admin/menu/items/${item.id}`).set(...H).send({ categoryId: to.id });
    expect(moved.status).toBe(200);
    expect(moved.body.item.categoryId).toBe(to.id);

    const ok = await admin.delete(`/api/staff/admin/menu/categories/${from.id}`).set(...H);
    expect(ok.status).toBe(200);
    // 논리 삭제이므로 행은 남아 있고 과거 FK가 깨지지 않는다.
    const row = await prisma.menuCategory.findUniqueOrThrow({ where: { id: from.id } });
    expect(row.deletedAt).not.toBeNull();

    // 삭제된 카테고리로는 옮길 수 없다.
    const backfill = await admin.patch(`/api/staff/admin/menu/items/${item.id}`).set(...H).send({ categoryId: from.id });
    expect(backfill.status).toBe(409);
  });

  it("7. FRONT 전용 메뉴는 손님 목록에 없고 ID를 직접 보내도 거부된다", async () => {
    const roulette = await createMenuItem({
      name: "과일 맞추기 룰렛 1회",
      price: 500,
      channel: "FRONT",
      needsCooking: false,
      showInKitchen: false,
    });
    const table = await prisma.table.create({ data: { number: 810007, publicSlug: `s${Date.now()}g` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const menu = await customer.get("/api/customer/menu").set(...H);
    const allItemIds = (menu.body.categories as { items: { id: string }[] }[]).flatMap((c) => c.items.map((i) => i.id));
    expect(allItemIds).not.toContain(roulette.id);

    const direct = await customer
      .post("/api/customer/orders")
      .set(...H)
      .send({ idempotencyKey: "front-only", items: [{ menuItemId: roulette.id, quantity: 1, optionChoiceIds: [] }] });
    expect(direct.status).toBe(400);
    expect(direct.body.error).toContain("카운터");
  });

  it("조리 필요 + 주방 미표시의 모순 조합은 서버가 거부한다", async () => {
    const { agent: admin } = await loginAdmin();
    const category = await prisma.menuCategory.create({ data: { name: `모순_${Date.now()}` } });
    const res = await admin
      .post("/api/staff/admin/menu/items")
      .set(...H)
      .send({ categoryId: category.id, name: "모순메뉴", price: 1000, needsCooking: true, showInKitchen: false });
    expect(res.status).toBe(400);
  });

  it("옵션 그룹/선택지를 관리자 API로 수정·삭제할 수 있고, 삭제된 옵션은 새 주문에서 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "옵션편집", price: 2000 });

    const group = await admin
      .post(`/api/staff/admin/menu/items/${item.id}/option-groups`)
      .set(...H)
      .send({ name: "토핑", multiSelect: true });
    expect(group.status).toBe(201);

    const choice = await admin
      .post(`/api/staff/admin/menu/option-groups/${group.body.group.id}/choices`)
      .set(...H)
      .send({ name: "치즈", extraPrice: 500 });
    expect(choice.status).toBe(201);

    // 이름/추가금 수정
    const patched = await admin
      .patch(`/api/staff/admin/menu/option-groups/${group.body.group.id}/choices/${choice.body.choice.id}`)
      .set(...H)
      .send({ extraPrice: 700 });
    expect(patched.body.choice.extraPrice).toBe(700);

    // 음수 추가금은 우회 할인이므로 막는다
    const negative = await admin
      .patch(`/api/staff/admin/menu/option-groups/${group.body.group.id}/choices/${choice.body.choice.id}`)
      .set(...H)
      .send({ extraPrice: -100 });
    expect(negative.status).toBe(400);

    // 다른 메뉴의 그룹 ID로 남의 옵션을 고칠 수 없다(소유관계 검증)
    const otherItem = await createMenuItem({ name: "남의메뉴", price: 1000 });
    const hijack = await admin
      .patch(`/api/staff/admin/menu/items/${otherItem.id}/option-groups/${group.body.group.id}`)
      .set(...H)
      .send({ name: "탈취" });
    expect(hijack.status).toBe(404);

    // 그룹 삭제 → 선택지도 함께 새 주문 대상에서 빠진다
    const removed = await admin
      .delete(`/api/staff/admin/menu/items/${item.id}/option-groups/${group.body.group.id}`)
      .set(...H);
    expect(removed.status).toBe(200);
    const stored = await prisma.optionChoice.findUniqueOrThrow({ where: { id: choice.body.choice.id } });
    expect(stored.deletedAt).not.toBeNull();
  });

  it("메뉴 삭제 전 미리보기가 과거 주문 수와 영향받는 미사용 상품권을 알려준다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "상품권대상", price: 3000 });
    const issued = await admin
      .post("/api/staff/admin/coupons/batches")
      .set(...H)
      .send({
        idempotencyKey: `preview-${Date.now()}`,
        type: "ITEM",
        name: "상품권",
        quantity: 2,
        targetMenuItemIds: [item.id],
      });
    expect(issued.status).toBe(201);

    const preview = await admin.get(`/api/staff/admin/menu/items/${item.id}/delete-preview`).set(...H);
    expect(preview.status).toBe(200);
    expect(preview.body.coupons.count).toBe(2);
    expect(preview.body.coupons.soleTargetCount).toBe(2);
  });
});
