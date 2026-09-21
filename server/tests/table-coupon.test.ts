import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";
import { computeBill } from "../src/services/billing.js";
import { computeRevenueSummary } from "../src/services/reporting.js";
import {
  createMenuItem,
  createOrderWithItem,
  createStaff,
  createTableWithMenu,
  closeTableSessionDirect,
  loginAdmin,
  loginAgent,
  loginFront,
  openTableSessionDirect,
} from "./helpers.js";

const H = ["X-BoardBite-Client", "1"] as const;

async function issue(admin: Awaited<ReturnType<typeof loginAgent>>, body: Record<string, unknown>) {
  const res = await admin
    .post("/api/staff/admin/coupons/batches")
    .set(...H)
    .send({ idempotencyKey: `tc-${Date.now()}-${Math.random()}`, ...body });
  return res.body.batch.codes[0] as string;
}

/** 주방이 거부한 주문은 손님에게 청구되지 않아야 한다(computeBill 정합성). */
describe("주방 거부 주문과 미수금", () => {
  it("REJECTED 주문은 청구액에서 빠지고, 남은 잔액이 0이면 테이블이 정상 종료된다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    const { username, password } = await createStaff("POS");
    const pos = await loginAgent(username, password);

    const { order: keep } = await createOrderWithItem(session.id, menuItem.id, 6000, 1);
    const { order: rejected } = await createOrderWithItem(session.id, menuItem.id, 4000, 1);

    // 거부 전에는 두 주문이 모두 청구된다.
    expect((await computeBill(session.id)).totalAmount).toBe(10000);

    const res = await pos.post(`/api/staff/pos/orders/${rejected.id}/reject`).set(...H).send({ reason: "재료 소진" });
    expect(res.status).toBe(200);

    // 거부된 주문 값은 더 이상 청구되지 않는다 — 예전에는 4,000원이 영원히 미수금으로 남았다.
    const bill = await computeBill(session.id);
    expect(bill.totalAmount).toBe(6000);
    expect(bill.remainingAmount).toBe(6000);

    // 남은 6,000원을 받으면 서빙 대기 없이 자동 종료된다.
    await prisma.order.update({ where: { id: keep.id }, data: { status: "SERVED", servedAt: new Date() } });
    const { agent: front } = await loginFront();
    const paid = await front
      .post(`/api/staff/front/table-sessions/${session.id}/payments`)
      .set(...H)
      .send({ idempotencyKey: `rej-${Date.now()}`, methodCode: "CARD", mode: "AMOUNT", amount: 6000 });
    expect(paid.status).toBe(201);
    expect(paid.body.bill.remainingAmount).toBe(0);
    expect(paid.body.settlement).toBe("CLOSED");
  });
});

/** 요구사항.md §6 — 테이블 후불 정산에서의 쿠폰 사용. 현장 결제와 같은 규칙을 따른다. */
describe("테이블 정산 쿠폰", () => {
  async function seedSession(price = 6000, quantity = 1) {
    const { table, menuItem } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    const { orderItem } = await createOrderWithItem(session.id, menuItem.id, price, quantity);
    return { table, menuItem, session, orderItem };
  }

  it("금액권을 적용하면 미수금이 줄고 쿠폰이 사용 완료가 된다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { session } = await seedSession(6000);
    const code = await issue(admin, { type: "AMOUNT", name: "테이블 금액권", amount: 2000, quantity: 1 });

    // 미리보기는 상태를 바꾸지 않는다.
    const preview = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon/preview`)
      .set(...H)
      .send({ code });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.discountAmount).toBe(2000);
    expect(preview.body.preview.remainingAfter).toBe(4000);
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("AVAILABLE");

    const applied = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon`)
      .set(...H)
      .send({ code, idempotencyKey: `apply-${Date.now()}` });
    expect(applied.status).toBe(201);
    expect(applied.body.bill.remainingAmount).toBe(4000);
    expect(applied.body.bill.discountAmount).toBe(2000);
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("USED");

    // 사용 기록이 테이블 세션에 붙는다(현장 거래가 아니라).
    const redemption = await prisma.couponRedemption.findFirstOrThrow({ where: { coupon: { code } } });
    expect(redemption.tableSessionId).toBe(session.id);
    expect(redemption.counterSaleId).toBeNull();
  });

  it("금액권 할인은 미수금을 넘지 않는다(잔액 소멸)", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { session } = await seedSession(1000);
    const code = await issue(admin, { type: "AMOUNT", name: "초과 금액권", amount: 5000, quantity: 1 });

    const applied = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon`)
      .set(...H)
      .send({ code, idempotencyKey: `over-${Date.now()}` });
    expect(applied.status).toBe(201);
    expect(applied.body.payment.amount).toBe(1000);
    expect(applied.body.bill.remainingAmount).toBe(0);
  });

  it("상품권은 지정 메뉴 1개의 기본가만 무료다(수량 2개여도 1개분)", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { table } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    const udon = await createMenuItem({ name: "테이블우동", price: 3000 });
    const { orderItem } = await createOrderWithItem(session.id, udon.id, 3000, 2);
    const code = await issue(admin, { type: "ITEM", name: "테이블 상품권", quantity: 1, targetMenuItemIds: [udon.id] });

    const preview = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon/preview`)
      .set(...H)
      .send({ code, targetOrderItemId: orderItem.id });
    // 6,000원 중 3,000원(1개 기본가)만 할인된다.
    expect(preview.body.preview.discountAmount).toBe(3000);
    expect(preview.body.preview.remainingBefore).toBe(6000);

    const applied = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon`)
      .set(...H)
      .send({ code, targetOrderItemId: orderItem.id, idempotencyKey: `item-${Date.now()}` });
    expect(applied.status).toBe(201);
    expect(applied.body.bill.remainingAmount).toBe(3000);
  });

  it("거래당 1장 — 같은 테이블에 두 번째 쿠폰은 거부된다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { session } = await seedSession(10000);
    const first = await issue(admin, { type: "AMOUNT", name: "1장", amount: 1000, quantity: 1 });
    const second = await issue(admin, { type: "AMOUNT", name: "2장", amount: 1000, quantity: 1 });

    await front.post(`/api/staff/front/table-sessions/${session.id}/coupon`).set(...H).send({ code: first, idempotencyKey: `a-${Date.now()}` });
    const res = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon`)
      .set(...H)
      .send({ code: second, idempotencyKey: `b-${Date.now()}` });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("COUPON_ALREADY_APPLIED");
    // 두 번째 쿠폰은 소진되지 않았다.
    expect((await prisma.coupon.findFirstOrThrow({ where: { code: second } })).status).toBe("AVAILABLE");
  });

  it("같은 쿠폰을 테이블과 현장에서 동시에 쓰면 정확히 하나만 성공한다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: frontA } = await loginFront();
    const { agent: frontB } = await loginFront();
    const { session } = await seedSession(10000);
    const counterItem = await createMenuItem({ name: "교차경합", price: 5000, channel: "FRONT", needsCooking: false, showInKitchen: false });
    const code = await issue(admin, { type: "AMOUNT", name: "교차권", amount: 1000, quantity: 1 });

    const [table, counter] = await Promise.all([
      frontA.post(`/api/staff/front/table-sessions/${session.id}/coupon`).set(...H).send({ code, idempotencyKey: `x1-${Date.now()}` }),
      frontB.post("/api/staff/front/counter/confirm").set(...H).send({
        idempotencyKey: `x2-${Date.now()}`,
        items: [{ menuItemId: counterItem.id, quantity: 1, optionChoiceIds: [] }],
        couponCode: code,
        methodCode: "CARD",
      }),
    ]);
    const successes = [table.status === 201, counter.status === 201].filter(Boolean);
    expect(successes).toHaveLength(1);
    expect(await prisma.couponRedemption.count({ where: { coupon: { code } } })).toBe(1);
  });

  it("같은 멱등 키 재전송은 할인을 두 번 적용하지 않는다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { session } = await seedSession(6000);
    const code = await issue(admin, { type: "AMOUNT", name: "멱등권", amount: 1000, quantity: 1 });
    const key = `idem-${Date.now()}`;

    const first = await front.post(`/api/staff/front/table-sessions/${session.id}/coupon`).set(...H).send({ code, idempotencyKey: key });
    const retry = await front.post(`/api/staff/front/table-sessions/${session.id}/coupon`).set(...H).send({ code, idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.payment.id).toBe(first.body.payment.id);
    expect((await computeBill(session.id)).discountAmount).toBe(1000);
  });

  it("쿠폰 할인은 매출이 아니라 쿠폰 할인으로 집계된다", async () => {
    const since = new Date();
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { session } = await seedSession(3000);
    const code = await issue(admin, { type: "AMOUNT", name: "집계권", amount: 1000, quantity: 1 });

    await front.post(`/api/staff/front/table-sessions/${session.id}/coupon`).set(...H).send({ code, idempotencyKey: `rep-${Date.now()}` });
    await front
      .post(`/api/staff/front/table-sessions/${session.id}/payments`)
      .set(...H)
      .send({ idempotencyKey: `pay-${Date.now()}`, methodCode: "CARD", mode: "AMOUNT", amount: 2000 });

    const summary = await computeRevenueSummary(since);
    expect(summary.couponDiscount).toBe(1000);
    expect(summary.manualDiscount).toBe(0);
    expect(summary.totalRevenue).toBe(2000);
    // 테이블 채널로 잡힌다.
    expect(summary.byChannel.table).toBe(2000);
    expect(summary.byMethod.find((m) => m.method === "COUPON")).toBeUndefined();
  });

  it("쿠폰 할인 결제를 취소하면 제공 실적도 취소되지만 쿠폰은 사용 완료로 남는다", async () => {
    const { agent: admin, password } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { session } = await seedSession(5000);
    const code = await issue(admin, { type: "AMOUNT", name: "취소권", amount: 2000, quantity: 1 });

    const applied = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon`)
      .set(...H)
      .send({ code, idempotencyKey: `cv-${Date.now()}` });
    expect(applied.status).toBe(201);

    await admin.post("/api/staff/step-up").set(...H).send({ password });
    const voided = await admin
      .post(`/api/staff/front/payments/${applied.body.payment.id}/void`)
      .set(...H)
      .send({ reason: "잘못 적용" });
    expect(voided.status).toBe(200);

    // 미수금이 원래대로 돌아온다.
    expect((await computeBill(session.id)).remainingAmount).toBe(5000);
    // 제공 실적은 취소되고, 쿠폰 자체는 사용 완료로 유지된다(자동 복구 없음).
    const redemption = await prisma.couponRedemption.findFirstOrThrow({ where: { coupon: { code } } });
    expect(redemption.cancelledAt).not.toBeNull();
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("USED");
  });

  it("종료된 테이블·잠긴 테이블·결제 잠금 상태에서는 쿠폰을 적용할 수 없다", async () => {
    const { agent: admin } = await loginAdmin();
    const { agent: front } = await loginFront();
    const { session, table } = await seedSession(5000);
    const code = await issue(admin, { type: "AMOUNT", name: "잠금권", amount: 1000, quantity: 1 });

    await prisma.table.update({ where: { id: table.id }, data: { paymentsLocked: true } });
    const locked = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon`)
      .set(...H)
      .send({ code, idempotencyKey: `lk-${Date.now()}` });
    expect(locked.status).toBe(403);
    await prisma.table.update({ where: { id: table.id }, data: { paymentsLocked: false } });

    await closeTableSessionDirect(session.id);
    const closed = await front
      .post(`/api/staff/front/table-sessions/${session.id}/coupon`)
      .set(...H)
      .send({ code, idempotencyKey: `cl-${Date.now()}` });
    expect(closed.status).toBe(409);
    expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).status).toBe("AVAILABLE");
  });

  it("쿠폰 사용처 CHECK 제약이 DB 레벨에서 강제된다", async () => {
    const { username } = await createStaff("FRONT");
    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
    const batch = await prisma.couponBatch.create({
      data: { type: "AMOUNT", name: "제약", amount: 100, issuedCount: 1, idempotencyKey: `chk-${Date.now()}`, createdById: staff.id },
    });
    const coupon = await prisma.coupon.create({ data: { batchId: batch.id, code: "997" } });

    // 사용처가 둘 다 비면 거부
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "CouponRedemption" ("id","couponId","originalAmount","discountAmount","benefitSnapshot","redeemedById","redeemedAt") VALUES ('bad-none','${coupon.id}',1,1,'{}','${staff.id}',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
  });
});
