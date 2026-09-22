import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import { computeBill } from "../src/services/billing.js";
import { assertValidSelectRange, checkSelectedCount, describeSelectRange } from "../src/services/optionRules.js";
import {
  createMenuItem,
  createOrderWithItem,
  createStaff,
  createTableWithMenu,
  loginAdmin,
  loginAgent,
  loginFront,
  openTableAndJoin,
  openTableSessionDirect,
} from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

/** 요구사항 5절 — 옵션 최소/최대 선택 개수. */
describe("옵션 선택 개수 범위", () => {
  it("규칙 문구가 범위를 사람이 읽을 수 있게 표현한다", () => {
    expect(describeSelectRange({ minSelect: 1, maxSelect: 1 })).toBe("필수");
    expect(describeSelectRange({ minSelect: 0, maxSelect: 1 })).toBe("선택");
    expect(describeSelectRange({ minSelect: 0, maxSelect: null })).toBe("여러 개 선택 가능");
    expect(describeSelectRange({ minSelect: 2, maxSelect: 3 })).toBe("2~3개");
    expect(describeSelectRange({ minSelect: 2, maxSelect: 2 })).toBe("2개 선택");
    expect(describeSelectRange({ minSelect: 0, maxSelect: 3 })).toBe("최대 3개");
    expect(describeSelectRange({ minSelect: 2, maxSelect: null })).toBe("2개 이상");
  });

  it("모순된 범위는 저장 시점에 막힌다", () => {
    expect(() => assertValidSelectRange({ minSelect: 3, maxSelect: 2 })).toThrow();
    expect(() => assertValidSelectRange({ minSelect: -1, maxSelect: null })).toThrow();
    expect(() => assertValidSelectRange({ minSelect: 0, maxSelect: 0 })).toThrow();
    // 고를 수 있는 선택지보다 최소 개수가 크면 판매 불가 메뉴가 되므로 막는다.
    expect(() => assertValidSelectRange({ minSelect: 3, maxSelect: null }, 2)).toThrow();
    expect(() => assertValidSelectRange({ minSelect: 2, maxSelect: 3 }, 3)).not.toThrow();
  });

  it("개수 검사가 최소/최대를 모두 판정한다", () => {
    const g = { name: "토핑", minSelect: 2, maxSelect: 3 };
    expect(checkSelectedCount(g, 1)).toContain("2개 이상");
    expect(checkSelectedCount(g, 2)).toBeNull();
    expect(checkSelectedCount(g, 3)).toBeNull();
    expect(checkSelectedCount(g, 4)).toContain("최대 3개");
    expect(checkSelectedCount({ name: "종류", minSelect: 1, maxSelect: 1 }, 2)).toContain("하나만");
  });

  /** "최소 2개, 최대 3개" 같은 임의 범위를 실제 주문 경로에서 검증한다. */
  it("임의 범위(2~3개)를 서버가 주문에서 강제한다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "범위메뉴", price: 5000 });
    const group = (
      await admin
        .post(`/api/staff/admin/menu/items/${item.id}/option-groups`)
        .set(...H)
        .send({ name: "토핑 2~3개", minSelect: 2, maxSelect: 3 })
    ).body.group;
    expect(group.minSelect).toBe(2);
    expect(group.maxSelect).toBe(3);

    const choices = [];
    for (const name of ["A", "B", "C", "D"]) {
      const c = await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name });
      choices.push(c.body.choice.id as string);
    }

    const table = await prisma.table.create({ data: { number: 840001, publicSlug: `sr${Date.now()}` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const order = (key: string, ids: string[]) =>
      customer
        .post("/api/customer/orders")
        .set(...H)
        .send({ idempotencyKey: key, items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: ids }] });

    // 1개 → 부족
    const tooFew = await order("few", [choices[0]]);
    expect(tooFew.status).toBe(400);
    expect(tooFew.body.code).toBe("OPTION_COUNT_INVALID");
    expect(tooFew.body.error).toContain("2개 이상");

    // 4개 → 초과
    const tooMany = await order("many", choices);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toContain("최대 3개");

    // 2개, 3개 → 성공
    expect((await order("ok2", choices.slice(0, 2))).status).toBe(201);
    expect((await order("ok3", choices.slice(0, 3))).status).toBe(201);
  });

  it("손님 화면이 규칙 문구와 파생값을 서버에서 받는다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "문구확인메뉴", price: 1000 });
    const group = (
      await admin
        .post(`/api/staff/admin/menu/items/${item.id}/option-groups`)
        .set(...H)
        .send({ name: "범위", minSelect: 1, maxSelect: 2 })
    ).body.group;
    await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "가" });
    await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "나" });

    const table = await prisma.table.create({ data: { number: 840002, publicSlug: `sr2${Date.now()}` } });
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    const menu = await customer.get("/api/customer/menu").set(...H);
    const shown = (menu.body.categories as { items: { id: string; optionGroups: { minSelect: number; maxSelect: number | null; required: boolean; multiSelect: boolean; selectRangeLabel: string }[] }[] }[])
      .flatMap((c) => c.items)
      .find((i) => i.id === item.id)!;
    const g = shown.optionGroups[0];
    expect(g.minSelect).toBe(1);
    expect(g.maxSelect).toBe(2);
    // 파생값이 함께 내려와 화면이 다시 계산하지 않는다.
    expect(g.required).toBe(true);
    expect(g.multiSelect).toBe(true);
    expect(g.selectRangeLabel).toBe("1~2개");
  });

  it("기존 required/multiSelect 입력도 받아 범위로 환산한다(호환)", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "호환메뉴", price: 1000 });
    const required = (
      await admin.post(`/api/staff/admin/menu/items/${item.id}/option-groups`).set(...H).send({ name: "필수단일", required: true })
    ).body.group;
    expect(required.minSelect).toBe(1);
    expect(required.maxSelect).toBe(1);

    const multi = (
      await admin.post(`/api/staff/admin/menu/items/${item.id}/option-groups`).set(...H).send({ name: "선택복수", multiSelect: true })
    ).body.group;
    expect(multi.minSelect).toBe(0);
    expect(multi.maxSelect).toBeNull();
  });

  it("모순된 범위를 API로 저장하려 하면 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "모순범위메뉴", price: 1000 });
    const group = (
      await admin.post(`/api/staff/admin/menu/items/${item.id}/option-groups`).set(...H).send({ name: "범위" })
    ).body.group;
    await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name: "하나" });

    const res = await admin
      .patch(`/api/staff/admin/menu/items/${item.id}/option-groups/${group.id}`)
      .set(...H)
      .send({ minSelect: 3, maxSelect: 2 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SELECT_RANGE_INVALID");

    // 선택지보다 큰 최소 개수도 막힌다.
    const tooBig = await admin
      .patch(`/api/staff/admin/menu/items/${item.id}/option-groups/${group.id}`)
      .set(...H)
      .send({ minSelect: 5 });
    expect(tooBig.status).toBe(400);
  });

  it("최소 개수를 채울 선택지가 품절로 부족하면 메뉴가 판매 불가가 된다", async () => {
    const { agent: admin } = await loginAdmin();
    const item = await createMenuItem({ name: "품절부족메뉴", price: 1000 });
    const group = (
      await admin.post(`/api/staff/admin/menu/items/${item.id}/option-groups`).set(...H).send({ name: "2개필수", minSelect: 2, maxSelect: 3 })
    ).body.group;
    const ids: string[] = [];
    for (const name of ["가", "나", "다"]) {
      const c = await admin.post(`/api/staff/admin/menu/option-groups/${group.id}/choices`).set(...H).send({ name });
      ids.push(c.body.choice.id);
    }

    // 3개 중 2개를 품절시키면 최소 2개를 채울 수 없다.
    await admin
      .post("/api/staff/admin/inventory/sold-out")
      .set(...H)
      .send({ targets: ids.slice(0, 2).map((id) => ({ kind: "OPTION_CHOICE", id })), soldOut: true });

    const adminMenu = await admin.get("/api/staff/admin/menu/categories").set(...H);
    const shown = (adminMenu.body.categories as { items: { id: string; blockedRequiredGroups: string[] }[] }[])
      .flatMap((c) => c.items)
      .find((i) => i.id === item.id)!;
    expect(shown.blockedRequiredGroups).toContain("2개필수");
  });
});

/** 위험 2 — 결제 후 취소로 생긴 환불 필요 상태가 눈에 보이고 종료가 막힌다. */
describe("결제 후 취소 시 환불 필요 처리", () => {
  it("환불이 필요한 테이블은 종료가 막히고 사유가 표시된다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    // 아직 서빙되지 않은 주문이다 — 완납해도 자동 종료되지 않고 PAID_PENDING_SERVICE로 남는다.
    const { order } = await createOrderWithItem(session.id, menuItem.id, 6000, 1, "PREPARING");
    const { agent: front } = await loginFront();
    const { username, password } = await createStaff("POS");
    const pos = await loginAgent(username, password);

    // 손님이 먼저 완납한다.
    const paid = await front
      .post(`/api/staff/front/table-sessions/${session.id}/payments`)
      .set(...H)
      .send({ idempotencyKey: `p-${Date.now()}`, methodCode: "CARD", mode: "AMOUNT", amount: 6000 });
    expect(paid.body.settlement).toBe("PENDING_SERVICE");

    // 그 뒤 주방이 조리 불가로 취소한다 → 받은 돈만 남아 초과 수납(환불 필요)이 된다.
    const cancelled = await pos.post(`/api/staff/pos/orders/${order.id}/cancel`).set(...H).send({ reasonCode: "CANNOT_COOK" });
    expect(cancelled.status).toBe(200);

    const bill = await computeBill(session.id);
    expect(bill.remainingAmount).toBeLessThan(0);

    // FRONT 목록이 환불 필요 금액을 드러낸다.
    const tables = await front.get("/api/staff/front/tables").set(...H);
    const row = (tables.body.tables as { id: string; bill?: { remainingAmount: number } }[]).find((t) => t.id === table.id)!;
    expect(row.bill!.remainingAmount).toBe(-6000);

    // 환불을 기록하기 전에는 테이블을 닫을 수 없다.
    const blocked = await front.post(`/api/staff/front/tables/${table.id}/close`).set(...H).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("CLOSE_BLOCKED");
    expect(JSON.stringify(blocked.body.blockers)).toContain("환불");

    // 환불을 기록하면 정상 종료된다.
    const payments = await prisma.payment.findMany({ where: { tableSessionId: session.id, kind: "CHARGE" } });
    await front.post("/api/staff/step-up").set(...H).send({ password });
    const { agent: admin, password: adminPw } = await loginAdmin();
    await admin.post("/api/staff/step-up").set(...H).send({ password: adminPw });
    const voided = await admin.post(`/api/staff/front/payments/${payments[0].id}/void`).set(...H).send({ reason: "조리 불가 환불" });
    expect(voided.status).toBe(200);
    expect((await computeBill(session.id)).remainingAmount).toBe(0);

    const closed = await front.post(`/api/staff/front/tables/${table.id}/close`).set(...H).send({});
    expect(closed.status).toBe(200);
  });
});
