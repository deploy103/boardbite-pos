import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLog } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";

export interface CreateOrderItemInput {
  menuItemId: string;
  quantity: number;
  optionChoiceIds: string[];
}

export interface CreateOrderInput {
  tableSessionId: string;
  clientIdempotencyKey: string;
  items: CreateOrderItemInput[];
  note?: string;
}

export class OrderValidationError extends Error {}

/**
 * 주문 생성. 가격/옵션/품절 여부는 전부 서버가 DB에서 다시 계산하며,
 * 클라이언트가 보낸 가격/합계는 절대 신뢰하지 않는다(docs/SECURITY.md §1).
 */
export async function createOrder(input: CreateOrderInput) {
  if (input.items.length === 0) {
    throw new OrderValidationError("주문할 메뉴를 선택해 주세요.");
  }

  // (tableSessionId, clientKey) 조합을 UNIQUE 제약으로 묶어 더블탭/재전송 중복을 원자적으로 차단한다.
  const idempotencyKey = `${input.tableSessionId}:${input.clientIdempotencyKey}`;

  const existing = await prisma.order.findUnique({
    where: { idempotencyKey },
    include: { items: { include: { options: true } } },
  });
  if (existing) return existing;

  const menuItemIds = [...new Set(input.items.map((i) => i.menuItemId))];
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds } },
    include: { optionGroups: { include: { choices: true } } },
  });
  const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));

  const allOptionChoiceIds = [...new Set(input.items.flatMap((i) => i.optionChoiceIds))];
  const optionChoices = await prisma.optionChoice.findMany({
    where: { id: { in: allOptionChoiceIds } },
    include: { group: true },
  });
  const optionChoiceMap = new Map(optionChoices.map((o) => [o.id, o]));

  const itemsToCreate = input.items.map((item) => {
    const menuItem = menuItemMap.get(item.menuItemId);
    if (!menuItem || !menuItem.isActive) {
      throw new OrderValidationError("판매하지 않는 메뉴가 포함되어 있습니다.");
    }
    if (menuItem.isSoldOut) {
      throw new OrderValidationError(`${menuItem.name}은(는) 품절되었습니다.`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
      throw new OrderValidationError("수량이 올바르지 않습니다.");
    }

    const options = item.optionChoiceIds.map((choiceId) => {
      const choice = optionChoiceMap.get(choiceId);
      if (!choice || !choice.isActive || choice.group.menuItemId !== menuItem.id) {
        throw new OrderValidationError("올바르지 않은 옵션이 포함되어 있습니다.");
      }
      return {
        optionChoiceId: choice.id,
        nameSnapshot: choice.name,
        extraPriceSnapshot: choice.extraPrice,
      };
    });

    return {
      menuItemId: menuItem.id,
      nameSnapshot: menuItem.name,
      unitPrice: menuItem.price,
      quantity: item.quantity,
      options,
    };
  });

  try {
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          tableSessionId: input.tableSessionId,
          idempotencyKey,
          note: input.note?.slice(0, 200),
          items: {
            create: itemsToCreate.map((item) => ({
              menuItemId: item.menuItemId,
              nameSnapshot: item.nameSnapshot,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
              options: { create: item.options },
            })),
          },
        },
        include: { items: { include: { options: true } } },
      });
      return created;
    });

    await recordAuditLog({
      actorType: "SYSTEM",
      action: "ORDER_CREATED",
      targetType: "Order",
      targetId: order.id,
      metadata: { tableSessionId: input.tableSessionId, itemCount: order.items.length },
    });

    appEvents.emit(RealtimeEvent.OrderCreated, { tableSessionId: input.tableSessionId, order });

    return order;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // 동시 요청 경합 — 다른 요청이 먼저 같은 idempotencyKey로 생성 완료함. 원래 응답을 반환.
      const winner = await prisma.order.findUnique({
        where: { idempotencyKey },
        include: { items: { include: { options: true } } },
      });
      if (winner) return winner;
    }
    throw err;
  }
}
