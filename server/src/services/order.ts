import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLogBestEffort } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import type { OrderStatus } from "../types/domain.js";
import { maybeAutoSettleTableSession } from "./tableSession.js";

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

type MenuItemWithOptions = Prisma.MenuItemGetPayload<{ include: { optionGroups: { include: { choices: true } } } }>;
type ChoiceWithGroup = Prisma.OptionChoiceGetPayload<{ include: { group: true } }>;

export interface OrderItemOptionSnapshot {
  optionChoiceId: string;
  nameSnapshot: string;
  extraPriceSnapshot: number;
}

/**
 * 메뉴 옵션 규칙을 서버에서 전부 다시 검증한다(요구사항2.md §3.3).
 * 클라이언트 UI를 우회해 API를 직접 호출해도 아래 규칙을 어긴 주문은 생성되지 않는다:
 *
 *  - 존재하지 않거나 비활성(isActive=false)인 choice 거부
 *  - 다른 메뉴에 속한 choice 거부
 *  - 같은 choice ID 중복 전송 거부
 *  - required=true 그룹은 정확히 선택되어야 함
 *  - multiSelect=false 그룹은 최대 1개
 *
 * 비활성 choice가 포함된 그룹이라도 required면 "선택 가능한 활성 choice"가 있어야 주문을 받는다.
 */
export function validateItemOptions(
  menuItem: MenuItemWithOptions,
  optionChoiceIds: string[],
  optionChoiceMap: Map<string, ChoiceWithGroup>,
): OrderItemOptionSnapshot[] {
  if (new Set(optionChoiceIds).size !== optionChoiceIds.length) {
    throw new OrderValidationError("같은 옵션을 중복해서 선택할 수 없습니다.");
  }

  const selectedByGroup = new Map<string, number>();
  const options: OrderItemOptionSnapshot[] = [];

  for (const choiceId of optionChoiceIds) {
    const choice = optionChoiceMap.get(choiceId);
    if (!choice || !choice.isActive || choice.group.menuItemId !== menuItem.id) {
      throw new OrderValidationError("올바르지 않은 옵션이 포함되어 있습니다.");
    }
    selectedByGroup.set(choice.groupId, (selectedByGroup.get(choice.groupId) ?? 0) + 1);
    options.push({
      optionChoiceId: choice.id,
      nameSnapshot: choice.name,
      extraPriceSnapshot: choice.extraPrice,
    });
  }

  for (const group of menuItem.optionGroups) {
    const count = selectedByGroup.get(group.id) ?? 0;
    if (!group.multiSelect && count > 1) {
      throw new OrderValidationError(`'${group.name}' 옵션은 하나만 선택할 수 있습니다.`);
    }
    if (group.required && count === 0) {
      const hasSelectableChoice = group.choices.some((choice) => choice.isActive);
      if (hasSelectableChoice) {
        throw new OrderValidationError(`'${group.name}' 옵션을 선택해 주세요.`);
      }
    }
  }

  return options;
}

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

    const options = validateItemOptions(menuItem, item.optionChoiceIds, optionChoiceMap);

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

    await recordAuditLogBestEffort({
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

// ---------------------------------------------------------------------------
// 주문 상태 머신 (docs/ARCHITECTURE.md §5.3)
//
//   NEW → ACCEPTED → PREPARING → READY → SERVED
//   NEW → REJECTED
//   NEW | ACCEPTED | PREPARING → CANCELLED
//
// 모든 전이는 감사 로그를 남기고 RealtimeEvent.OrderStatusChanged를 emit한다.
// ---------------------------------------------------------------------------

export class OrderStateError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

const ORDER_INCLUDE = { items: { include: { options: true } } } as const;
const ORDER_WITH_TABLE_INCLUDE = {
  items: { include: { options: true } },
  tableSession: { include: { table: true } },
} as const;

/**
 * 주문 상태 전이를 단 한 번의 조건부 UPDATE로 수행한다(요구사항2.md §3.6).
 *
 *   UPDATE "Order" SET status=? WHERE id=? AND status IN (허용된 이전 상태)
 *
 * 변경된 행이 정확히 1건일 때만 성공으로 본다. "SELECT → 확인 → UPDATE" 방식과 달리
 * 두 직원이 동시에 같은 버튼을 눌러도 한쪽만 성공하고 다른 쪽은 409를 받는다.
 */
async function applyTransition(
  orderId: string,
  fromStatuses: OrderStatus[],
  toStatus: OrderStatus,
  extraData: Prisma.OrderUncheckedUpdateManyInput,
  staffId: string,
  action: string,
  metadata?: Record<string, unknown>,
) {
  const result = await prisma.order.updateMany({
    where: { id: orderId, status: { in: fromStatuses } },
    data: { status: toStatus, ...extraData },
  });

  if (result.count !== 1) {
    // 실패 원인을 구분해 운영자가 바로 이해할 수 있는 메시지를 준다.
    const current = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!current) throw new OrderStateError("존재하지 않는 주문입니다.", 404);
    throw new OrderStateError(`현재 상태(${current.status})에서는 이 작업을 할 수 없어요.`);
  }

  const updated = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action,
    targetType: "Order",
    targetId: orderId,
    metadata,
  });
  appEvents.emit(RealtimeEvent.OrderStatusChanged, {
    tableSessionId: updated.tableSessionId,
    orderId: updated.id,
    status: updated.status,
  });
  return updated;
}

export function acceptOrder(orderId: string, staffId: string) {
  return applyTransition(orderId, ["NEW"], "ACCEPTED", { acceptedAt: new Date() }, staffId, "ORDER_ACCEPTED");
}

export async function rejectOrder(orderId: string, staffId: string, reason: string) {
  const order = await applyTransition(orderId, ["NEW"], "REJECTED", { rejectReason: reason }, staffId, "ORDER_REJECTED", { reason });
  await maybeAutoSettleTableSession(order.tableSessionId);
  return order;
}

export function startPreparing(orderId: string, staffId: string) {
  return applyTransition(orderId, ["ACCEPTED"], "PREPARING", { preparingAt: new Date() }, staffId, "ORDER_PREPARING");
}

export function markReady(orderId: string, staffId: string) {
  return applyTransition(orderId, ["PREPARING"], "READY", { readyAt: new Date() }, staffId, "ORDER_READY");
}

export async function markServed(orderId: string, staffId: string) {
  const order = await applyTransition(orderId, ["READY"], "SERVED", { servedAt: new Date() }, staffId, "ORDER_SERVED");
  // 완납 후 마지막 미서빙 주문이 이제 SERVED가 되었다면 테이블을 자동 CLOSE한다(요구사항.md §4.4).
  await maybeAutoSettleTableSession(order.tableSessionId);
  return order;
}

/** 잘못 누른 서빙 완료를 되돌린다. 시간 제한/권한 정책은 라우트(SERVING) 레벨에서 강제한다. */
export function revertServedToReady(orderId: string, staffId: string) {
  return applyTransition(orderId, ["SERVED"], "READY", { servedAt: null }, staffId, "ORDER_SERVED_REVERTED");
}

export async function cancelOrder(orderId: string, staffId: string, reason: string) {
  const order = await applyTransition(
    orderId,
    ["NEW", "ACCEPTED", "PREPARING"],
    "CANCELLED",
    { cancelReason: reason, cancelledAt: new Date() },
    staffId,
    "ORDER_CANCELLED",
    { reason },
  );
  // 취소로 인해 미수금이 음수(환불 필요)가 될 수 있다 — computeBill()이 그대로 드러내며 별도 플래그는 두지 않는다.
  await maybeAutoSettleTableSession(order.tableSessionId);
  return order;
}

/** KDS 보드용 — 활성 주문(NEW/ACCEPTED/PREPARING/READY)을 상태별로 묶어 반환한다. */
export async function listOrdersForKitchen() {
  const orders = await prisma.order.findMany({
    where: { status: { in: ["NEW", "ACCEPTED", "PREPARING", "READY"] } },
    orderBy: { createdAt: "asc" },
    include: ORDER_WITH_TABLE_INCLUDE,
  });

  const grouped: Record<"NEW" | "ACCEPTED" | "PREPARING" | "READY", typeof orders> = {
    NEW: [],
    ACCEPTED: [],
    PREPARING: [],
    READY: [],
  };
  for (const order of orders) {
    grouped[order.status as "NEW" | "ACCEPTED" | "PREPARING" | "READY"]?.push(order);
  }
  return grouped;
}

export interface OrderHistoryFilter {
  status?: OrderStatus;
  tableNumber?: number;
  limit?: number;
}

/** 이전 주문 이력/취소 목록 검색(POS "이력"/"취소" 탭). */
export async function searchOrderHistory(filter: OrderHistoryFilter) {
  const where: Prisma.OrderWhereInput = {};
  if (filter.status) where.status = filter.status;
  if (filter.tableNumber) {
    where.tableSession = { table: { number: filter.tableNumber } };
  }
  return prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.limit ?? 50, 200),
    include: ORDER_WITH_TABLE_INCLUDE,
  });
}
