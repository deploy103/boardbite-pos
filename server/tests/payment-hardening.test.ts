import { describe, it, expect } from "vitest";
import { createStaff, loginAgent, createTableWithMenu, openTableSessionDirect, createOrderWithItem } from "./helpers.js";
import { prisma } from "../src/prisma.js";
import { createPayment, PaymentValidationError, scopePaymentIdempotencyKey } from "../src/services/payment.js";

/**
 * 요구사항2.md §3.4(allocation 중복) / §3.5(idempotency scope) / §12 Payment 매트릭스.
 */
async function sessionWithItems(unitPrice = 5000, quantity = 2) {
  const { table, menuItem } = await createTableWithMenu();
  const session = await openTableSessionDirect(table.id);
  const { orderItem } = await createOrderWithItem(session.id, menuItem.id, unitPrice, quantity);
  const staff = await prisma.staffUser.findFirstOrThrow({ where: { role: "FRONT" } });
  return { table, session, orderItem, staffId: staff.id };
}

describe("결제 allocation 중복 방지", () => {
  it("같은 orderItemId를 두 줄로 나눠 보내면 거부된다", async () => {
    const { session, orderItem, staffId } = await sessionWithItems();

    await expect(
      createPayment({
        tableSessionId: session.id,
        idempotencyKey: "dup-alloc",
        methodCode: "CARD",
        mode: "ITEMS",
        allocations: [
          { orderItemId: orderItem.id, quantity: 1 },
          { orderItemId: orderItem.id, quantity: 1 },
        ],
        createdById: staffId,
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);

    // 아무 결제도 남지 않아야 한다.
    expect(await prisma.payment.count({ where: { tableSessionId: session.id } })).toBe(0);
  });

  it("다른 테이블 세션의 항목은 결제할 수 없다", async () => {
    const a = await sessionWithItems();
    const b = await sessionWithItems();

    await expect(
      createPayment({
        tableSessionId: a.session.id,
        idempotencyKey: "cross-session",
        methodCode: "CARD",
        mode: "ITEMS",
        allocations: [{ orderItemId: b.orderItem.id, quantity: 1 }],
        createdById: a.staffId,
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });

  it("세션 전체 잔액을 넘는 상품별 결제는 거부된다", async () => {
    const { session, orderItem, staffId } = await sessionWithItems(5000, 2); // 총 10,000원

    // 먼저 금액 기반으로 전액 수납한다.
    await createPayment({
      tableSessionId: session.id,
      idempotencyKey: "pay-full",
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 10000,
      createdById: staffId,
    });

    // 잔액이 0인데 상품별 결제를 또 시도하면 초과 수납이다.
    await expect(
      createPayment({
        tableSessionId: session.id,
        idempotencyKey: "pay-again",
        methodCode: "CARD",
        mode: "ITEMS",
        allocations: [{ orderItemId: orderItem.id, quantity: 1 }],
        createdById: staffId,
      }),
    ).rejects.toBeInstanceOf(PaymentValidationError);
  });
});

describe("결제 idempotency key 범위", () => {
  it("DB에는 테이블 세션으로 한정된 키가 저장된다", async () => {
    const { session, staffId } = await sessionWithItems();
    await createPayment({
      tableSessionId: session.id,
      idempotencyKey: "client-key-1",
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 1000,
      createdById: staffId,
    });

    const stored = await prisma.payment.findFirst({ where: { tableSessionId: session.id } });
    expect(stored!.idempotencyKey).toBe(scopePaymentIdempotencyKey(session.id, "client-key-1"));
    // 클라이언트가 보낸 raw key가 그대로 전역 유일 키로 쓰이지 않는다.
    expect(stored!.idempotencyKey).not.toBe("client-key-1");
  });

  it("같은 클라이언트 키를 다른 테이블에서 써도 충돌하지 않는다", async () => {
    const a = await sessionWithItems();
    const b = await sessionWithItems();

    const first = await createPayment({
      tableSessionId: a.session.id,
      idempotencyKey: "shared-key",
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 1000,
      createdById: a.staffId,
    });
    const second = await createPayment({
      tableSessionId: b.session.id,
      idempotencyKey: "shared-key",
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 2000,
      createdById: b.staffId,
    });

    // 서로 다른 결제로 기록되어야 한다(이전 구조라면 두 번째가 첫 번째를 그대로 돌려줬다).
    expect(second.payment.id).not.toBe(first.payment.id);
    expect(second.payment.amount).toBe(2000);
  });

  it("같은 테이블에서 같은 키를 다시 쓰면 기존 결제를 그대로 돌려준다(더블 서브밋 방지)", async () => {
    const { session, staffId } = await sessionWithItems();
    const input = {
      tableSessionId: session.id,
      idempotencyKey: "double-submit",
      methodCode: "CARD" as const,
      mode: "AMOUNT" as const,
      amount: 1000,
      createdById: staffId,
    };
    const first = await createPayment(input);
    const second = await createPayment(input);

    expect(second.payment.id).toBe(first.payment.id);
    expect(await prisma.payment.count({ where: { tableSessionId: session.id } })).toBe(1);
  });
});

describe("결제 취소 (VOID/REFUND)", () => {
  it("HTTP 경로에서는 step-up 없이 취소할 수 없다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    await createOrderWithItem(session.id, menuItem.id, 5000, 1);
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);

    const paid = await front
      .post(`/api/staff/front/table-sessions/${session.id}/payments`)
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "to-void", methodCode: "CARD", mode: "AMOUNT", amount: 1000 });
    expect(paid.status).toBe(201);

    const voidRes = await front
      .post(`/api/staff/front/payments/${paid.body.payment.id}/void`)
      .set("X-BoardBite-Client", "1")
      .send({ reason: "잘못 입력" });
    expect(voidRes.status).toBe(403);
    expect(voidRes.body.code).toBe("STEP_UP_REQUIRED");

    // 재인증 후에는 정상 처리된다.
    await front.post("/api/staff/step-up").set("X-BoardBite-Client", "1").send({ password });
    const retried = await front
      .post(`/api/staff/front/payments/${paid.body.payment.id}/void`)
      .set("X-BoardBite-Client", "1")
      .send({ reason: "잘못 입력" });
    expect(retried.status).toBe(200);
  });
});
