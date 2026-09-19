import { describe, it, expect } from "vitest";
import { computeBill } from "../src/services/billing.js";
import { prisma } from "../src/prisma.js";
import { createTableWithMenu, createStaff } from "./helpers.js";

/**
 * computeBill()은 순수하게 Order/OrderItem/OrderItemOption/Payment를 집계해 파생 계산하므로
 * (server/src/services/billing.ts), 여기서는 order.ts(주문 생성 서비스, 동시 수정 중)를 거치지 않고
 * prisma로 직접 Order/OrderItem을 만들어 계산 로직만 독립적으로 검증한다.
 */
async function createTableSession() {
  const { table } = await createTableWithMenu();
  const { username } = await createStaff("FRONT");
  const staff = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
  const session = await prisma.tableSession.create({
    data: { tableId: table.id, openedById: staff.id },
  });
  return session;
}

async function createOrderWithItems(
  tableSessionId: string,
  status: string,
  items: Array<{ menuItemId: string; unitPrice: number; quantity: number; options?: Array<{ optionChoiceId: string; extraPrice: number }> }>,
) {
  const order = await prisma.order.create({
    data: {
      tableSessionId,
      status,
      idempotencyKey: `idem_${tableSessionId}_${status}_${Date.now()}_${Math.random()}`,
    },
  });
  for (const item of items) {
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        menuItemId: item.menuItemId,
        nameSnapshot: "스냅샷메뉴",
        unitPrice: item.unitPrice,
        quantity: item.quantity,
      },
    });
    for (const opt of item.options ?? []) {
      await prisma.orderItemOption.create({
        data: {
          orderItemId: orderItem.id,
          optionChoiceId: opt.optionChoiceId,
          nameSnapshot: "옵션스냅샷",
          extraPriceSnapshot: opt.extraPrice,
        },
      });
    }
  }
  return order;
}

async function createOptionChoice(extraPrice: number) {
  const category = await prisma.menuCategory.create({ data: { name: `cat_${Date.now()}_${Math.random()}` } });
  const menuItem = await prisma.menuItem.create({ data: { categoryId: category.id, name: "옵션메뉴", price: 1000 } });
  const group = await prisma.optionGroup.create({ data: { menuItemId: menuItem.id, name: "옵션그룹" } });
  const choice = await prisma.optionChoice.create({ data: { groupId: group.id, name: "옵션", extraPrice } });
  return choice;
}

describe("computeBill 정산 로직", () => {
  it("옵션 추가금을 포함해 취소되지 않은 주문 항목들의 합계를 정확히 계산한다", async () => {
    const session = await createTableSession();
    const { menuItem } = await createTableWithMenu(); // 임의 메뉴 사용 (가격은 무시하고 unitPrice 직접 지정)
    const optionA = await createOptionChoice(500);
    const optionB = await createOptionChoice(300);

    // 주문 1: 옵션 2개가 붙은 상품 2개 = (6000 + 500 + 300) * 2 = 13600
    await createOrderWithItems(session.id, "SERVED", [
      {
        menuItemId: menuItem.id,
        unitPrice: 6000,
        quantity: 2,
        options: [
          { optionChoiceId: optionA.id, extraPrice: 500 },
          { optionChoiceId: optionB.id, extraPrice: 300 },
        ],
      },
    ]);
    // 주문 2: 옵션 없는 상품 1개 = 3000
    await createOrderWithItems(session.id, "READY", [{ menuItemId: menuItem.id, unitPrice: 3000, quantity: 1 }]);

    const bill = await computeBill(session.id);
    expect(bill.totalAmount).toBe(13600 + 3000);
  });

  it("status가 CANCELLED인 주문은 합계에서 제외된다", async () => {
    const session = await createTableSession();
    const { menuItem } = await createTableWithMenu();

    await createOrderWithItems(session.id, "SERVED", [{ menuItemId: menuItem.id, unitPrice: 5000, quantity: 1 }]);
    const beforeCancelled = await computeBill(session.id);
    expect(beforeCancelled.totalAmount).toBe(5000);

    // 매우 비싼 주문을 취소 상태로 추가해도 합계에는 반영되지 않아야 한다.
    await createOrderWithItems(session.id, "CANCELLED", [{ menuItemId: menuItem.id, unitPrice: 999_999, quantity: 3 }]);

    const afterCancelled = await computeBill(session.id);
    expect(afterCancelled.totalAmount).toBe(5000);
  });

  it("Payment 라우트가 아직 없으므로 paidAmount는 항상 0이고 remainingAmount는 totalAmount와 같다", async () => {
    // TODO(Phase 5): Payment/PaymentAllocation 라우트가 생기면 이 테스트는
    // 실제 결제 생성 후 paidAmount/remainingAmount 변화를 검증하도록 갱신해야 한다.
    const session = await createTableSession();
    const { menuItem } = await createTableWithMenu();
    await createOrderWithItems(session.id, "SERVED", [{ menuItemId: menuItem.id, unitPrice: 4200, quantity: 2 }]);

    const bill = await computeBill(session.id);
    expect(bill.paidAmount).toBe(0);
    expect(bill.remainingAmount).toBe(bill.totalAmount);
    expect(bill.totalAmount).toBe(8400);
  });
});
