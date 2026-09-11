import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLog } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import type { OrderStatus } from "../types/domain.js";

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

async function requireOrder(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!order) throw new OrderStateError("존재하지 않는 주문입니다.", 404);
  return order;
}

async function applyTransition(
  orderId: string,
  fromStatuses: OrderStatus[],
  toStatus: OrderStatus,
  extraData: Prisma.OrderUpdateInput,
  staffId: string,
  action: string,
  metadata?: Record<string, unknown>,
) {
  const order = await requireOrder(orderId);
  if (!fromStatuses.includes(order.status as OrderStatus)) {
    throw new OrderStateError(`현재 상태(${order.status})에서는 이 작업을 할 수 없어요.`);
  }
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: toStatus, ...extraData },
    include: ORDER_INCLUDE,
  });
  await recordAuditLog({
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

export function rejectOrder(orderId: string, staffId: string, reason: string) {
  return applyTransition(orderId, ["NEW"], "REJECTED", { rejectReason: reason }, staffId, "ORDER_REJECTED", { reason });
}

export function startPreparing(orderId: string, staffId: string) {
  return applyTransition(orderId, ["ACCEPTED"], "PREPARING", { preparingAt: new Date() }, staffId, "ORDER_PREPARING");
}

export function markReady(orderId: string, staffId: string) {
  return applyTransition(orderId, ["PREPARING"], "READY", { readyAt: new Date() }, staffId, "ORDER_READY");
}

export function markServed(orderId: string, staffId: string) {
  return applyTransition(orderId, ["READY"], "SERVED", { servedAt: new Date() }, staffId, "ORDER_SERVED");
}

/** 잘못 누른 서빙 완료를 되돌린다. 시간 제한/권한 정책은 라우트(SERVING) 레벨에서 강제한다. */
export function revertServedToReady(orderId: string, staffId: string) {
  return applyTransition(orderId, ["SERVED"], "READY", { servedAt: null }, staffId, "ORDER_SERVED_REVERTED");
}

export function cancelOrder(orderId: string, staffId: string, reason: string) {
  return applyTransition(
    orderId,
    ["NEW", "ACCEPTED", "PREPARING"],
    "CANCELLED",
    { cancelReason: reason, cancelledAt: new Date() },
    staffId,
    "ORDER_CANCELLED",
    { reason },
  );
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
