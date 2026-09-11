import { describe, it, expect } from "vitest";
import { prisma } from "../src/prisma.js";
import { createPayment, createDiscount, voidPayment, PaymentValidationError } from "../src/services/payment.js";
import { markServed, acceptOrder, startPreparing, markReady } from "../src/services/order.js";
import {
  createStaff,
  createTableWithMenu,
  createOrderWithItem,
  openTableSessionDirect,
  getStaffIdByUsername,
} from "./helpers.js";

async function setup(unitPrice = 6000, quantity = 2, orderStatus = "SERVED") {
  const { table, menuItem } = await createTableWithMenu();
  await prisma.menuItem.update({ where: { id: menuItem.id }, data: { price: unitPrice } });
  const front = await createStaff("FRONT");
  const session = await openTableSessionDirect(table.id, front.username);
  const staffId = await getStaffIdByUsername(front.username);
  const { order, orderItem } = await createOrderWithItem(session.id, menuItem.id, unitPrice, quantity, orderStatus);
  return { table, menuItem, session, staffId, order, orderItem };
}

function key(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random()}`;
}

describe("결제 생성 — 금액 기반(AMOUNT)", () => {
  it("남은 금액 이내의 카드 결제는 성공하고 남은 금액이 정확히 줄어든다", async () => {
    const { session, staffId } = await setup(6000, 2); // 총 12000
    const result = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("pay"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 5000,
      createdById: staffId,
    });
    expect(result.payment.amount).toBe(5000);
    expect(result.bill.remainingAmount).toBe(7000);
  });

  it("비현금 결제는 남은 금액을 초과할 수 없다", async () => {
    const { session, staffId } = await setup(6000, 1); // 총 6000
    await expect(
      createPayment({
        tableSessionId: session.id,
        idempotencyKey: key("pay"),
        methodCode: "CARD",
        mode: "AMOUNT",
        amount: 7000,
        createdById: staffId,
      }),
    ).rejects.toThrow(PaymentValidationError);
  });

  it("현금 결제는 초과 수납이 가능하며 거스름돈이 정확히 계산된다", async () => {
    const { session, staffId } = await setup(6000, 1); // 총 6000
    const result = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("pay"),
      methodCode: "CASH",
      mode: "AMOUNT",
      tenderedAmount: 10000,
      createdById: staffId,
    });
    expect(result.payment.amount).toBe(6000);
    expect(result.payment.tenderedAmount).toBe(10000);
    expect(result.payment.changeAmount).toBe(4000);
    expect(result.bill.remainingAmount).toBe(0);
  });

  it("현금 부분결제는 받은 금액만큼만 적용되고 거스름돈은 0이다", async () => {
    const { session, staffId } = await setup(6000, 2); // 총 12000
    const result = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("pay"),
      methodCode: "CASH",
      mode: "AMOUNT",
      tenderedAmount: 5000,
      createdById: staffId,
    });
    expect(result.payment.amount).toBe(5000);
    expect(result.payment.changeAmount).toBe(0);
    expect(result.bill.remainingAmount).toBe(7000);
  });

  it("동일 idempotencyKey로 두 번 요청해도 결제는 1건만 생성된다", async () => {
    const { session, staffId } = await setup(6000, 2);
    const idempotencyKey = key("dup");
    const [r1, r2] = await Promise.all([
      createPayment({ tableSessionId: session.id, idempotencyKey, methodCode: "CARD", mode: "AMOUNT", amount: 5000, createdById: staffId }),
      createPayment({ tableSessionId: session.id, idempotencyKey, methodCode: "CARD", mode: "AMOUNT", amount: 5000, createdById: staffId }),
    ]);
    expect(r1.payment.id).toBe(r2.payment.id);
    const count = await prisma.payment.count({ where: { tableSessionId: session.id } });
    expect(count).toBe(1);
  });

  it("두 결제를 동시에 요청해도 합계가 총액을 초과하지 않는다(동시성 방어)", async () => {
    const { session, staffId } = await setup(10000, 1); // 총 10000
    const results = await Promise.allSettled([
      createPayment({ tableSessionId: session.id, idempotencyKey: key("race1"), methodCode: "CARD", mode: "AMOUNT", amount: 8000, createdById: staffId }),
      createPayment({ tableSessionId: session.id, idempotencyKey: key("race2"), methodCode: "CARD", mode: "AMOUNT", amount: 8000, createdById: staffId }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const bill = await prisma.payment.aggregate({ where: { tableSessionId: session.id, kind: "CHARGE" }, _sum: { amount: true } });
    expect(bill._sum.amount).toBe(8000);
  });

  it("결제 기능이 전체 비활성화되어 있으면 결제를 생성할 수 없다", async () => {
    const { session, staffId } = await setup(6000, 1);
    await prisma.operationSettings.update({ where: { id: 1 }, data: { paymentsEnabled: false } });
    try {
      await expect(
        createPayment({ tableSessionId: session.id, idempotencyKey: key("blocked"), methodCode: "CARD", mode: "AMOUNT", amount: 1000, createdById: staffId }),
      ).rejects.toThrow(PaymentValidationError);
    } finally {
      await prisma.operationSettings.update({ where: { id: 1 }, data: { paymentsEnabled: true } });
    }
  });

  it("특정 테이블이 정산 잠금 상태이면 그 테이블만 결제를 생성할 수 없다", async () => {
    const { session, staffId, table } = await setup(6000, 1);
    await prisma.table.update({ where: { id: table.id }, data: { paymentsLocked: true } });
    await expect(
      createPayment({ tableSessionId: session.id, idempotencyKey: key("locked"), methodCode: "CARD", mode: "AMOUNT", amount: 1000, createdById: staffId }),
    ).rejects.toThrow(PaymentValidationError);
  });
});

describe("결제 생성 — 상품별(ITEMS)", () => {
  it("동일 상품 2개 중 1개만 결제할 수 있고, 나머지 1개만 남는다", async () => {
    const { session, staffId, orderItem } = await setup(6000, 2);

    const first = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("item1"),
      methodCode: "CARD",
      mode: "ITEMS",
      allocations: [{ orderItemId: orderItem.id, quantity: 1 }],
      createdById: staffId,
    });
    expect(first.payment.amount).toBe(6000);
    expect(first.bill.remainingAmount).toBe(6000);

    // 남은 1개 초과해서 2개 결제 시도 -> 거부
    await expect(
      createPayment({
        tableSessionId: session.id,
        idempotencyKey: key("item2-over"),
        methodCode: "CARD",
        mode: "ITEMS",
        allocations: [{ orderItemId: orderItem.id, quantity: 2 }],
        createdById: staffId,
      }),
    ).rejects.toThrow(PaymentValidationError);

    // 남은 1개만 결제 -> 성공, 잔액 0
    const second = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("item2"),
      methodCode: "CARD",
      mode: "ITEMS",
      allocations: [{ orderItemId: orderItem.id, quantity: 1 }],
      createdById: staffId,
    });
    expect(second.bill.remainingAmount).toBe(0);
  });

  it("옵션 추가금이 있는 항목의 상품별 결제 금액은 옵션을 포함해 계산된다", async () => {
    const { session, staffId, menuItem } = await setup(6000, 1);
    const group = await prisma.optionGroup.create({ data: { menuItemId: menuItem.id, name: "옵션" } });
    const choice = await prisma.optionChoice.create({ data: { groupId: group.id, name: "곱빼기", extraPrice: 1000 } });

    const order = await prisma.order.create({
      data: {
        tableSessionId: session.id,
        idempotencyKey: key("order-with-option"),
        items: {
          create: [
            {
              menuItemId: menuItem.id,
              nameSnapshot: "옵션메뉴",
              unitPrice: 6000,
              quantity: 1,
              options: { create: [{ optionChoiceId: choice.id, nameSnapshot: "곱빼기", extraPriceSnapshot: 1000 }] },
            },
          ],
        },
      },
      include: { items: true },
    });

    const result = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("pay-option"),
      methodCode: "CARD",
      mode: "ITEMS",
      allocations: [{ orderItemId: order.items[0].id, quantity: 1 }],
      createdById: staffId,
    });
    expect(result.payment.amount).toBe(7000);
  });

  it("취소된 주문의 항목은 상품별 결제 대상이 될 수 없다", async () => {
    const { session, staffId, orderItem } = await setup(6000, 1, "CANCELLED");
    await expect(
      createPayment({
        tableSessionId: session.id,
        idempotencyKey: key("cancelled-item"),
        methodCode: "CARD",
        mode: "ITEMS",
        allocations: [{ orderItemId: orderItem.id, quantity: 1 }],
        createdById: staffId,
      }),
    ).rejects.toThrow(PaymentValidationError);
  });
});

describe("완납 시 테이블 자동 처리", () => {
  it("미서빙 주문이 없는 상태에서 완납하면 테이블이 자동으로 CLOSE된다", async () => {
    const { session, staffId, table } = await setup(6000, 1, "SERVED");
    const result = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("full"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 6000,
      createdById: staffId,
    });
    expect(result.settlement).toBe("CLOSED");

    const closedSession = await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(closedSession.status).toBe("CLOSED");
    const closedTable = await prisma.table.findUniqueOrThrow({ where: { id: table.id } });
    expect(closedTable.status).toBe("AVAILABLE");
  });

  it("미서빙 주문이 남아있으면 PAID_PENDING_SERVICE로 전환되고, 서빙완료 시 자동 CLOSE된다", async () => {
    const { session, staffId, table, order } = await setup(6000, 1, "READY");

    const result = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("pending-service"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 6000,
      createdById: staffId,
    });
    expect(result.settlement).toBe("PENDING_SERVICE");

    const pendingSession = await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(pendingSession.status).toBe("PAID_PENDING_SERVICE");
    const settlingTable = await prisma.table.findUniqueOrThrow({ where: { id: table.id } });
    expect(settlingTable.status).toBe("SETTLING");

    await markServed(order.id, staffId);

    const closedSession = await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(closedSession.status).toBe("CLOSED");
    const closedTable = await prisma.table.findUniqueOrThrow({ where: { id: table.id } });
    expect(closedTable.status).toBe("AVAILABLE");
  });

  it("PAID_PENDING_SERVICE 상태에서 남아있던 주문이 접수→조리→준비완료→서빙완료를 모두 거쳐도 정확히 자동 CLOSE된다", async () => {
    const { session, staffId, order } = await setup(6000, 1, "NEW");

    const result = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("full-lifecycle"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 6000,
      createdById: staffId,
    });
    expect(result.settlement).toBe("PENDING_SERVICE");

    await acceptOrder(order.id, staffId);
    await startPreparing(order.id, staffId);
    await markReady(order.id, staffId);
    await markServed(order.id, staffId);

    const closedSession = await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(closedSession.status).toBe("CLOSED");
  });
});

describe("할인", () => {
  it("할인은 미수금을 줄이지만 chargedAmount(매출)에는 포함되지 않는다", async () => {
    const { session, staffId } = await setup(6000, 2); // 총 12000
    const result = await createDiscount({
      tableSessionId: session.id,
      idempotencyKey: key("discount"),
      amount: 2000,
      reason: "행사 할인",
      createdById: staffId,
    });
    expect(result.bill.discountAmount).toBe(2000);
    expect(result.bill.chargedAmount).toBe(0);
    expect(result.bill.remainingAmount).toBe(10000);
  });

  it("남은 금액보다 큰 할인은 거부된다", async () => {
    const { session, staffId } = await setup(6000, 1);
    await expect(
      createDiscount({ tableSessionId: session.id, idempotencyKey: key("too-much"), amount: 999999, reason: "사유", createdById: staffId }),
    ).rejects.toThrow(PaymentValidationError);
  });
});

describe("결제 취소(VOID)", () => {
  it("결제를 취소하면 남은 금액이 원래대로 돌아오고 감사 로그가 남는다", async () => {
    // 총액 12000 중 6000만 결제 — 잔액이 남아 세션이 계속 ACTIVE 상태여야 VOID(즉시 취소)로 분류된다.
    const { session, staffId } = await setup(6000, 2);
    const { payment } = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("to-void"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 6000,
      createdById: staffId,
    });

    const voidResult = await voidPayment(payment.id, staffId, "손님 요청");
    expect(voidResult.payment.kind).toBe("VOID");
    expect(voidResult.bill.remainingAmount).toBe(12000);

    const log = await prisma.auditLog.findFirst({ where: { targetId: payment.id, action: "PAYMENT_VOIDED" } });
    expect(log).not.toBeNull();
  });

  it("이미 취소된 결제를 다시 취소할 수 없다", async () => {
    const { session, staffId } = await setup(6000, 1);
    const { payment } = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("double-void"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 6000,
      createdById: staffId,
    });
    await voidPayment(payment.id, staffId, "1차 취소");
    await expect(voidPayment(payment.id, staffId, "2차 취소")).rejects.toThrow(PaymentValidationError);
  });

  it("완납으로 자동 CLOSE된 후 결제를 취소하면 REFUND로 기록되고 미수금이 다시 발생한다", async () => {
    const { session, staffId } = await setup(6000, 1, "SERVED");
    const { payment, settlement } = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("refund-scenario"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 6000,
      createdById: staffId,
    });
    expect(settlement).toBe("CLOSED");

    const refundResult = await voidPayment(payment.id, staffId, "환불 요청");
    expect(refundResult.payment.kind).toBe("REFUND");
    expect(refundResult.bill.remainingAmount).toBe(6000);
  });

  it("취소 사유 없이는 취소할 수 없다", async () => {
    const { session, staffId } = await setup(6000, 1);
    const { payment } = await createPayment({
      tableSessionId: session.id,
      idempotencyKey: key("reason-required"),
      methodCode: "CARD",
      mode: "AMOUNT",
      amount: 6000,
      createdById: staffId,
    });
    await expect(voidPayment(payment.id, staffId, "")).rejects.toThrow(PaymentValidationError);
  });
});
