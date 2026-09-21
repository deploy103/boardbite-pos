import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import {
  createCounterOnlyItem,
  createMenuItem,
  createStaff,
  loginAdmin,
  loginAgent,
  loginFront,
  openTableSessionDirect,
} from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

async function confirm(front: Awaited<ReturnType<typeof loginAgent>>, body: Record<string, unknown>) {
  return front.post("/api/staff/front/counter/confirm").set(...H).send(body);
}

/**
 * 요구사항.md §9 인수 테스트 6, 8, 11~13, 16, 18 — FRONT 현장 결제.
 */
describe("FRONT 현장 결제 (인수 6, 8, 11~13, 16, 18)", () => {
  it("6. 테이블을 하나도 열지 않고 룰렛 500원/1,000원을 판매한다 — Table/TableSession이 생기지 않는다", async () => {
    const tablesBefore = await prisma.table.count();
    const sessionsBefore = await prisma.tableSession.count();

    const { agent: front } = await loginFront();
    const once = await createCounterOnlyItem("과일 맞추기 룰렛 1회", 500);
    const thrice = await createCounterOnlyItem("과일 맞추기 룰렛 3회", 1000);

    const res = await confirm(front, {
      idempotencyKey: `roulette-${Date.now()}`,
      items: [
        { menuItemId: once.id, quantity: 1, optionChoiceIds: [] },
        { menuItemId: thrice.id, quantity: 1, optionChoiceIds: [] },
      ],
      methodCode: "CASH",
      tenderedAmount: 2000,
    });
    expect(res.status).toBe(201);
    expect(res.body.sale.ledger.netChargedAmount).toBe(1500);
    expect(res.body.sale.saleNo).toBeGreaterThan(0);

    // 가짜 테이블/세션/입장 코드가 생기지 않았다.
    expect(await prisma.table.count()).toBe(tablesBefore);
    expect(await prisma.tableSession.count()).toBe(sessionsBefore);

    // 현장 제공 상품은 KDS 조리 대기를 만들지 않는다.
    const orders = await prisma.order.findMany({ where: { counterSaleId: res.body.sale.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("SERVED");

    // 거스름돈이 기록된다.
    const charge = res.body.sale.payments.find((p: { kind: string }) => p.kind === "CHARGE");
    expect(charge.tenderedAmount).toBe(2000);
    expect(charge.changeAmount).toBe(500);
  });

  it("8. 우동+룰렛 혼합 결제 — 주방에는 우동만 뜨고 룰렛은 현장 완료, 우동만 따로 수령 완료", async () => {
    const { agent: front } = await loginFront();
    const { username, password } = await createStaff("POS");
    const pos = await loginAgent(username, password);

    const udon = await createMenuItem({ name: "현장우동", price: 3000, channel: "BOTH" });
    const group = await prisma.optionGroup.create({
      data: { menuItemId: udon.id, name: "추가 토핑", required: false, multiSelect: true },
    });
    const egg = await prisma.optionChoice.create({ data: { groupId: group.id, name: "계란 추가", extraPrice: 500 } });
    const roulette = await createCounterOnlyItem("혼합룰렛", 500);

    const res = await confirm(front, {
      idempotencyKey: `mix-${Date.now()}`,
      items: [
        { menuItemId: udon.id, quantity: 1, optionChoiceIds: [egg.id] },
        { menuItemId: roulette.id, quantity: 1, optionChoiceIds: [] },
      ],
      methodCode: "CARD",
    });
    expect(res.status).toBe(201);
    const sale = res.body.sale;
    expect(sale.ledger.netChargedAmount).toBe(4000);

    // 주문이 조리/현장으로 나뉜다.
    const kitchen = sale.orders.find((o: { servingMode: string }) => o.servingMode === "KITCHEN");
    const counter = sale.orders.find((o: { servingMode: string }) => o.servingMode === "COUNTER");
    expect(kitchen.status).toBe("NEW");
    expect(counter.status).toBe("SERVED"); // 룰렛은 결제 확인이 곧 제공 확정
    expect(sale.pickupPending).toBe(true);

    // KDS에는 우동만, 현장 주문번호와 옵션이 함께 보인다.
    const board = await pos.get("/api/staff/pos/board").set(...H);
    const onBoard = board.body.orders.NEW.find((o: { id: string }) => o.id === kitchen.id);
    expect(onBoard).toBeTruthy();
    expect(onBoard.tableSession).toBeNull();
    expect(onBoard.counterSale.saleNo).toBe(sale.saleNo);
    expect(onBoard.items).toHaveLength(1);
    expect(onBoard.items[0].nameSnapshot).toBe("현장우동");
    expect(onBoard.items[0].options[0].nameSnapshot).toBe("계란 추가");
    expect(board.body.orders.NEW.find((o: { id: string }) => o.id === counter.id)).toBeUndefined();

    // 조리 완료 후 FRONT가 주문번호로 수령 완료 처리한다.
    await pos.post(`/api/staff/pos/orders/${kitchen.id}/accept`).set(...H).send({});
    await pos.post(`/api/staff/pos/orders/${kitchen.id}/start-preparing`).set(...H).send({});
    await pos.post(`/api/staff/pos/orders/${kitchen.id}/ready`).set(...H).send({});

    const pickedUp = await front.post(`/api/staff/front/counter/orders/${kitchen.id}/picked-up`).set(...H).send({});
    expect(pickedUp.status).toBe(200);
    expect(pickedUp.body.sale.pickupPending).toBe(false);

    // 중복 수령 처리는 409
    const again = await front.post(`/api/staff/front/counter/orders/${kitchen.id}/picked-up`).set(...H).send({});
    expect(again.status).toBe(409);
  });

  it("현장 주문은 SERVING의 서빙 대기 목록에 나타나지 않는다(테이블로 가져다 주는 화면이 아니다)", async () => {
    const { agent: front } = await loginFront();
    const { username, password } = await createStaff("POS");
    const pos = await loginAgent(username, password);
    const { username: sUser, password: sPass } = await createStaff("SERVING");
    const serving = await loginAgent(sUser, sPass);

    const food = await createMenuItem({ name: "서빙제외확인", price: 1000 });
    const res = await confirm(front, {
      idempotencyKey: `serving-${Date.now()}`,
      items: [{ menuItemId: food.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });
    const orderId = res.body.sale.orders[0].id;
    for (const step of ["accept", "start-preparing", "ready"]) {
      await pos.post(`/api/staff/pos/orders/${orderId}/${step}`).set(...H).send({});
    }

    const ready = await serving.get("/api/staff/serving/ready").set(...H);
    expect(ready.body.orders.find((o: { id: string }) => o.id === orderId)).toBeUndefined();
  });

  it("12/13. 같은 멱등 키 재전송은 거래를 1건만 만들고, 다른 본문이면 409로 거부한다", async () => {
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("멱등테스트", 1000);
    const key = `idem-${Date.now()}`;
    const body = {
      idempotencyKey: key,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    };

    const first = await confirm(front, body);
    expect(first.status).toBe(201);
    const retry = await confirm(front, body);
    expect(retry.status).toBe(200);
    expect(retry.body.reused).toBe(true);
    expect(retry.body.sale.id).toBe(first.body.sale.id);

    // 수납은 정확히 한 번만 기록된다.
    const charges = await prisma.payment.count({ where: { counterSaleId: first.body.sale.id, kind: "CHARGE" } });
    expect(charges).toBe(1);

    // 같은 키 + 다른 내용 = 명시적 충돌
    const conflict = await confirm(front, { ...body, items: [{ menuItemId: item.id, quantity: 2, optionChoiceIds: [] }] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("12. 더블탭(동시 전송)에도 거래·수납이 각각 1건만 생긴다", async () => {
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("더블탭", 2000);
    const key = `double-${Date.now()}`;
    const body = {
      idempotencyKey: key,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    };

    const [a, b] = await Promise.all([confirm(front, body), confirm(front, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.sale.id).toBe(b.body.sale.id);
    expect(await prisma.payment.count({ where: { counterSaleId: a.body.sale.id, kind: "CHARGE" } })).toBe(1);
  });

  it("13. 미리보기 이후 가격이 바뀌면 확정이 거부되고 새 금액을 함께 돌려준다", async () => {
    const { agent: front } = await loginFront();
    const { agent: admin } = await loginAdmin();
    const item = await createCounterOnlyItem("가격변동", 1000);
    const cart = { items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }] };

    const quote = await front.post("/api/staff/front/counter/quote").set(...H).send(cart);
    expect(quote.status).toBe(200);
    expect(quote.body.quote.totalAmount).toBe(1000);

    await admin.patch(`/api/staff/admin/menu/items/${item.id}`).set(...H).send({ price: 1500 });

    const stale = await confirm(front, {
      ...cart,
      idempotencyKey: `stale-${Date.now()}`,
      methodCode: "CARD",
      expectedQuoteHash: quote.body.quote.quoteHash,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("QUOTE_STALE");
    expect(stale.body.quote.totalAmount).toBe(1500);

    // 거래가 남지 않았다.
    expect(await prisma.counterSale.count({ where: { requestHash: { not: "" } , orders: { some: { items: { some: { menuItemId: item.id } } } } } })).toBe(0);
  });

  it("클라이언트가 보낸 금액은 신뢰하지 않는다 — 품절/삭제/비활성 메뉴는 거부된다", async () => {
    const { agent: front } = await loginFront();
    const { agent: admin } = await loginAdmin();
    const soldOut = await createCounterOnlyItem("품절상품", 1000);
    await prisma.menuItem.update({ where: { id: soldOut.id }, data: { isSoldOut: true } });

    const res = await confirm(front, {
      idempotencyKey: `soldout-${Date.now()}`,
      items: [{ menuItemId: soldOut.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });
    expect(res.status).toBe(400);

    const deleted = await createCounterOnlyItem("삭제상품", 1000);
    await admin.delete(`/api/staff/admin/menu/items/${deleted.id}`).set(...H);
    const res2 = await confirm(front, {
      idempotencyKey: `deleted-${Date.now()}`,
      items: [{ menuItemId: deleted.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });
    expect(res2.status).toBe(400);
  });

  it("현금 수납액이 부족하면 확정되지 않는다", async () => {
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("현금부족", 3000);
    const res = await confirm(front, {
      idempotencyKey: `cash-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CASH",
      tenderedAmount: 1000,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TENDER_INSUFFICIENT");
  });

  it("16. 권한 밖 역할과 손님은 현장 결제/거래 조회를 할 수 없다", async () => {
    const item = await createCounterOnlyItem("권한테스트", 1000);
    const payload = {
      idempotencyKey: `authz-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    };

    // 비로그인
    const { default: request } = await import("supertest");
    const { app } = await import("./helpers.js");
    const anon = await request(app).post("/api/staff/front/counter/confirm").set(...H).send(payload);
    expect(anon.status).toBe(401);

    for (const role of ["POS", "SERVING"] as const) {
      const { username, password } = await createStaff(role);
      const agent = await loginAgent(username, password);
      expect((await agent.post("/api/staff/front/counter/confirm").set(...H).send(payload)).status).toBe(403);
      expect((await agent.get("/api/staff/front/counter/sales").set(...H)).status).toBe(403);
      expect((await agent.get("/api/staff/front/counter/coupons/001").set(...H)).status).toBe(403);
    }

    // CSRF 커스텀 헤더 없이는 거부된다.
    const { agent: front } = await loginFront();
    const noCsrf = await front.post("/api/staff/front/counter/confirm").send(payload);
    expect(noCsrf.status).toBeGreaterThanOrEqual(400);
  });

  it("18. 전역 결제/주문 잠금은 현장 결제에도 적용된다", async () => {
    const { agent: front } = await loginFront();
    const { agent: admin } = await loginAdmin();
    const item = await createCounterOnlyItem("잠금테스트", 1000);
    const body = () => ({
      idempotencyKey: `lock-${Date.now()}-${Math.random()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });

    await admin.patch("/api/staff/admin/settings").set(...H).send({ paymentsEnabled: false });
    expect((await confirm(front, body())).status).toBe(403);
    await admin.patch("/api/staff/admin/settings").set(...H).send({ paymentsEnabled: true, orderingEnabled: false });
    expect((await confirm(front, body())).status).toBe(403);
    await admin.patch("/api/staff/admin/settings").set(...H).send({ orderingEnabled: true });
    expect((await confirm(front, body())).status).toBe(201);
  });

  it("18. 응답을 놓쳐도 같은 멱등 키로 결과를 되찾을 수 있다", async () => {
    const { agent: front } = await loginFront();
    const item = await createCounterOnlyItem("복구테스트", 1000);
    const key = `recover-${Date.now()}`;

    const before = await front.get(`/api/staff/front/counter/by-key/${key}`).set(...H);
    expect(before.body.sale).toBeNull();

    const created = await confirm(front, {
      idempotencyKey: key,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });
    const after = await front.get(`/api/staff/front/counter/by-key/${key}`).set(...H);
    expect(after.body.sale.id).toBe(created.body.sale.id);
  });

  it("주방이 현장 조리 주문을 거절하면 '환불 필요'로 드러나고, 테이블 자동 종료는 실행되지 않는다", async () => {
    const { agent: front } = await loginFront();
    const { username, password } = await createStaff("POS");
    const pos = await loginAgent(username, password);
    const food = await createMenuItem({ name: "거절대상", price: 4000 });

    const sale = await confirm(front, {
      idempotencyKey: `reject-${Date.now()}`,
      items: [{ menuItemId: food.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CASH",
      tenderedAmount: 4000,
    });
    const orderId = sale.body.sale.orders[0].id;

    const rejected = await pos
      .post(`/api/staff/pos/orders/${orderId}/reject`)
      .set(...H)
      .send({ reason: "재료 소진" });
    expect(rejected.status).toBe(200);

    const detail = await front.get(`/api/staff/front/counter/sales/${sale.body.sale.id}`).set(...H);
    // 자동 환불은 하지 않는다 — 실제 환불 기록 전까지 '환불 필요'로 남는다.
    expect(detail.body.sale.refundNeeded).toBe(true);
    expect(detail.body.sale.ledger.netChargedAmount).toBe(4000);

    const open = await front.get("/api/staff/front/counter/sales?onlyOpen=true").set(...H);
    expect(open.body.sales.some((s: { id: string }) => s.id === sale.body.sale.id)).toBe(true);
  });

  it("현장 거래 전체 취소는 ADMIN + step-up이 필요하고, 중복 요청이 이중 환불을 만들지 않는다", async () => {
    const { agent: front } = await loginFront();
    const { agent: admin, password } = await loginAdmin();
    const item = await createCounterOnlyItem("취소대상", 5000);

    const sale = await confirm(front, {
      idempotencyKey: `cancel-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CASH",
      tenderedAmount: 5000,
    });
    const saleId = sale.body.sale.id;

    // FRONT는 취소할 수 없다(ADMIN 전용 경로)
    expect((await front.post(`/api/staff/admin/counter-sales/${saleId}/cancel`).set(...H).send({ reason: "x" })).status).toBe(403);

    // step-up 없이는 거부
    const noStepUp = await admin.post(`/api/staff/admin/counter-sales/${saleId}/cancel`).set(...H).send({ reason: "손님 요청" });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.code).toBe("STEP_UP_REQUIRED");

    await admin.post("/api/staff/step-up").set(...H).send({ password });
    const cancelled = await admin.post(`/api/staff/admin/counter-sales/${saleId}/cancel`).set(...H).send({ reason: "손님 요청" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.sale.status).toBe("CANCELLED");
    expect(cancelled.body.sale.ledger.netChargedAmount).toBe(0);
    expect(cancelled.body.sale.ledger.refundedAmount).toBe(5000);

    // 재요청해도 환불 행이 늘지 않는다.
    const again = await admin.post(`/api/staff/admin/counter-sales/${saleId}/cancel`).set(...H).send({ reason: "중복 시도" });
    expect(again.status).toBe(200);
    expect(await prisma.payment.count({ where: { counterSaleId: saleId, kind: "REFUND" } })).toBe(1);

    // 조리 주문도 함께 취소된다.
    const orders = await prisma.order.findMany({ where: { counterSaleId: saleId } });
    expect(orders.every((o) => o.status === "CANCELLED")).toBe(true);
  });

  it("현장 결제 행은 결제 건별 취소(VOID) 경로로 되돌릴 수 없다 — 거래 전체 취소 한 경로만 쓴다", async () => {
    const { agent: front } = await loginFront();
    const { agent: admin, password } = await loginAdmin();
    const item = await createCounterOnlyItem("개별취소차단", 1000);
    const sale = await confirm(front, {
      idempotencyKey: `void-${Date.now()}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
      methodCode: "CARD",
    });
    const paymentId = sale.body.sale.payments[0].id;

    await admin.post("/api/staff/step-up").set(...H).send({ password });
    const res = await admin.post(`/api/staff/front/payments/${paymentId}/void`).set(...H).send({ reason: "시도" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("거래 전체 취소");
  });


  it("3. 같은 메뉴라도 옵션 조합이 다르면 별도 행으로 계산되고 각각 스냅샷이 남는다", async () => {
    const { agent: front } = await loginFront();
    const udon = await createMenuItem({ name: "조합구분우동", price: 3000, channel: "FRONT" });
    const g = await prisma.optionGroup.create({ data: { menuItemId: udon.id, name: "토핑", multiSelect: true } });
    const egg = await prisma.optionChoice.create({ data: { groupId: g.id, name: "계란", extraPrice: 500 } });

    const quote = await front
      .post("/api/staff/front/counter/quote")
      .set(...H)
      .send({
        items: [
          { menuItemId: udon.id, quantity: 1, optionChoiceIds: [] },
          { menuItemId: udon.id, quantity: 1, optionChoiceIds: [egg.id] },
        ],
      });
    expect(quote.status).toBe(200);
    expect(quote.body.quote.lines).toHaveLength(2);
    expect(quote.body.quote.lines[0].lineTotal).toBe(3000);
    expect(quote.body.quote.lines[1].lineTotal).toBe(3500);
    expect(quote.body.quote.subtotal).toBe(6500);

    const sale = await confirm(front, {
      idempotencyKey: `combo-${Date.now()}`,
      items: [
        { menuItemId: udon.id, quantity: 1, optionChoiceIds: [] },
        { menuItemId: udon.id, quantity: 1, optionChoiceIds: [egg.id] },
      ],
      methodCode: "CARD",
    });
    expect(sale.status).toBe(201);
    const items = sale.body.sale.orders.flatMap((o: { items: unknown[] }) => o.items);
    expect(items).toHaveLength(2);
    // 옵션 없는 행과 계란 행이 하나로 뭉개지지 않는다.
    expect(items.filter((i: { options: unknown[] }) => i.options.length === 0)).toHaveLength(1);
    expect(items.filter((i: { options: unknown[] }) => i.options.length === 1)).toHaveLength(1);
  });

  it("상품권은 메뉴 ID로 검증한다 — 이름이 같은 다른 메뉴에는 적용되지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const real = await createMenuItem({ name: "동명우동", price: 3000, channel: "FRONT" });
    const impostor = await createMenuItem({ name: "동명우동", price: 3000, channel: "FRONT" });
    expect(real.id).not.toBe(impostor.id);

    const code = (
      await admin
        .post("/api/staff/admin/coupons/batches")
        .set(...H)
        .send({ idempotencyKey: `same-${Date.now()}`, type: "ITEM", name: "동명권", quantity: 1, targetMenuItemIds: [real.id] })
    ).body.batch.codes[0];

    // 이름만 같은 다른 메뉴에는 적용되지 않는다.
    const wrong = await front
      .post("/api/staff/front/counter/quote")
      .set(...H)
      .send({ items: [{ menuItemId: impostor.id, quantity: 1, optionChoiceIds: [] }], couponCode: code });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("COUPON_TARGET_MISSING");

    // 지정된 메뉴에는 적용된다.
    const right = await front
      .post("/api/staff/front/counter/quote")
      .set(...H)
      .send({ items: [{ menuItemId: real.id, quantity: 1, optionChoiceIds: [] }], couponCode: code });
    expect(right.status).toBe(200);
    expect(right.body.quote.discountAmount).toBe(3000);
  });

  it("금액권 할인은 행 금액 비례로 배분되고 배분 합계가 결제 금액과 정확히 일치한다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const a = await createCounterOnlyItem("배분A", 333);
    const b = await createCounterOnlyItem("배분B", 667);
    const code = (
      await admin
        .post("/api/staff/admin/coupons/batches")
        .set(...H)
        .send({ idempotencyKey: `alloc-${Date.now()}`, type: "AMOUNT", name: "배분권", amount: 100, quantity: 1 })
    ).body.batch.codes[0];

    const sale = await confirm(front, {
      idempotencyKey: `alloc2-${Date.now()}`,
      items: [
        { menuItemId: a.id, quantity: 1, optionChoiceIds: [] },
        { menuItemId: b.id, quantity: 1, optionChoiceIds: [] },
      ],
      couponCode: code,
      methodCode: "CASH",
      tenderedAmount: 900,
    });
    expect(sale.status).toBe(201);
    // 1,000원 - 100원 = 900원만 수납한다.
    expect(sale.body.sale.ledger.netChargedAmount).toBe(900);

    const payments = await prisma.payment.findMany({
      where: { counterSaleId: sale.body.sale.id },
      include: { allocations: true },
    });
    for (const payment of payments) {
      // 어떤 결제든 행별 배분 합계가 결제 금액과 정확히 같아야 한다.
      expect(payment.allocations.reduce((s, x) => s + x.amount, 0)).toBe(payment.amount);
    }
    const discount = payments.find((p) => p.kind === "DISCOUNT")!;
    // §12.3 예시: 333/667원에 100원 → 34/66원
    expect(discount.allocations.map((x) => x.amount).sort((x, y) => x - y)).toEqual([34, 66]);
  });

  it("주문 소유자 CHECK 제약이 DB 레벨에서 강제된다(둘 다 채우거나 둘 다 비면 거부)", async () => {
    const item = await createCounterOnlyItem("제약검증", 100);
    const { username } = await createStaff("FRONT");
    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
    const sale = await prisma.counterSale.create({
      data: { saleNo: 900000 + Math.floor(Math.random() * 90000), createdById: staff.id, idempotencyKey: `chk-${Date.now()}`, requestHash: "x" },
    });
    // openTableSessionDirect를 쓴다 — Table.status까지 OPEN으로 맞춰야
    // "활성 세션이 있는 테이블은 OPEN/SETTLING" 전역 불변식(table-close.test.ts)이 깨지지 않는다.
    const table = await prisma.table.create({ data: { number: 820001, publicSlug: `chk${Date.now()}` } });
    const session = await openTableSessionDirect(table.id);

    // 둘 다 없음
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Order" ("id","status","idempotencyKey","createdAt") VALUES ('bad1','NEW','bad1',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
    // 둘 다 있음
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Order" ("id","tableSessionId","counterSaleId","status","idempotencyKey","createdAt") VALUES ('bad2','${session.id}','${sale.id}','NEW','bad2',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
    void item;
  });
});
