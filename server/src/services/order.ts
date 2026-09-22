import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLogBestEffort } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import type { OrderStatus } from "../types/domain.js";
import { maybeAutoSettleTableSession } from "./tableSession.js";
import { LIVE_OPTION_INCLUDE, channelAllows, servingModeOf, type ServingMode } from "./menuCatalog.js";
import {
  INVENTORY_SELECT,
  applySoldOutInTx,
  emitAvailabilityChanged,
  isSoldOut,
  type SoldOutTarget,
} from "./inventory.js";
import { withWriteConflictRetry } from "./writeConflict.js";
import type { Db } from "./billing.js";

export interface CreateOrderItemInput {
  menuItemId: string;
  quantity: number;
  optionChoiceIds: string[];
}

export interface CreateOrderInput {
  /**
   * 클라이언트가 화면에 표시했던 합계(요구사항 5절 — 요청 가격과 서버 계산 가격 일치 검증).
   * 서버는 이 값을 **계산에 쓰지 않는다.** 서버가 다시 계산한 금액과 다르면 주문을 거절해,
   * 손님 화면이 옛 가격을 보고 있었다는 사실을 조용히 넘기지 않는다.
   */
  expectedTotal?: number;
  tableSessionId: string;
  clientIdempotencyKey: string;
  items: CreateOrderItemInput[];
  note?: string;
}

export class OrderValidationError extends Error {
  /** 화면이 분기할 수 있는 기계용 오류 코드(요구사항 5절). */
  constructor(message: string, public code = "ORDER_INVALID") {
    super(message);
  }
}

type MenuItemWithOptions = Prisma.MenuItemGetPayload<{
  include: { optionGroups: { include: { choices: { include: typeof INVENTORY_SELECT } } } };
}>;
type ChoiceWithGroup = Prisma.OptionChoiceGetPayload<{
  include: { group: true } & typeof INVENTORY_SELECT;
}>;

export interface OrderItemOptionSnapshot {
  optionChoiceId: string;
  /** 주문 시점의 옵션 그룹명 스냅샷 — 나중에 그룹 이름이 바뀌어도 주방/영수증 표시가 흔들리지 않는다. */
  groupNameSnapshot: string;
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
    const groupIsLive = choice ? menuItem.optionGroups.some((g) => g.id === choice.groupId) : false;
    if (!choice || !choice.isActive || choice.deletedAt || !groupIsLive || choice.group.menuItemId !== menuItem.id) {
      // 삭제/비활성 그룹의 선택지는 "메뉴에 속한 활성 옵션"이 아니므로 동일하게 거부한다.
      throw new OrderValidationError("올바르지 않은 옵션이 포함되어 있습니다.", "OPTION_INVALID");
    }
    if (isSoldOut(choice)) {
      // 재고 품목이 품절된 옵션. 화면에는 회색으로 보이지만 서버가 최종적으로 막는다
      // (손님이 품절 직전에 담아둔 장바구니를 그대로 제출하는 경우).
      throw new OrderValidationError(`${choice.name}은(는) 품절되었어요. 다른 옵션을 선택해 주세요.`, "OPTION_SOLD_OUT");
    }
    selectedByGroup.set(choice.groupId, (selectedByGroup.get(choice.groupId) ?? 0) + 1);
    options.push({
      optionChoiceId: choice.id,
      groupNameSnapshot: choice.group.name,
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
      // 고를 수 있는 선택지가 하나도 없는 필수 그룹은 "선택 불가"가 아니라 "판매 불가"다
      // (요구사항.md §3.1) — 조용히 통과시키면 필수 규칙이 사실상 사라진다.
      const selectable = group.choices.filter((choice) => choice.isActive && !isSoldOut(choice));
      const allSoldOut = group.choices.length > 0 && selectable.length === 0;
      throw new OrderValidationError(
        selectable.length > 0
          ? `'${group.name}' 옵션을 선택해 주세요.`
          : allSoldOut
            ? `${menuItem.name}의 '${group.name}' 옵션이 모두 품절되어 지금은 주문할 수 없어요.`
            : `${menuItem.name}의 '${group.name}' 옵션에 선택할 수 있는 항목이 없어 지금은 주문할 수 없어요. 관리자에게 알려 주세요.`,
      );
    }
  }

  return options;
}

export interface ResolvedOrderLine {
  menuItemId: string;
  nameSnapshot: string;
  unitPrice: number;
  quantity: number;
  servingMode: ServingMode;
  options: OrderItemOptionSnapshot[];
  /** (기본단가 + 옵션 추가금) × 수량 — 할인 전 금액. */
  lineTotal: number;
}

/**
 * 장바구니 입력을 "서버가 계산한 주문 줄"로 바꾼다. 테이블 주문(createOrder)과
 * FRONT 현장 결제(counterSale.ts)가 같은 함수를 쓰므로 가격/옵션/채널/품절/삭제 규칙이
 * 두 경로에서 어긋날 수 없다. 클라이언트가 보낸 가격·합계는 어디서도 읽지 않는다.
 *
 * `db`에 트랜잭션 클라이언트를 넘기면 그 트랜잭션 안의 최신 상태로 재검증한다
 * (확정 직전 재검증 — 요구사항.md §12.2 4단계).
 */
export async function resolveOrderLines(
  items: CreateOrderItemInput[],
  target: "TABLE" | "FRONT",
  db: Db = prisma,
): Promise<ResolvedOrderLine[]> {
  if (items.length === 0) {
    throw new OrderValidationError("주문할 메뉴를 선택해 주세요.");
  }

  const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
  const menuItems = await db.menuItem.findMany({
    where: { id: { in: menuItemIds } },
    include: LIVE_OPTION_INCLUDE,
  });
  const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));

  const allOptionChoiceIds = [...new Set(items.flatMap((i) => i.optionChoiceIds))];
  const optionChoices = allOptionChoiceIds.length
    ? await db.optionChoice.findMany({
        where: { id: { in: allOptionChoiceIds } },
        // 연결된 재고 품목이 품절이면 그 옵션도 주문할 수 없다 — 확정 시점에 다시 확인한다.
        include: { group: true, ...INVENTORY_SELECT },
      })
    : [];
  const optionChoiceMap = new Map(optionChoices.map((o) => [o.id, o]));

  return items.map((item) => {
    const menuItem = menuItemMap.get(item.menuItemId);
    if (!menuItem || !menuItem.isActive || menuItem.deletedAt) {
      throw new OrderValidationError("판매하지 않는 메뉴가 포함되어 있습니다.");
    }
    if (!channelAllows(menuItem.channel, target)) {
      throw new OrderValidationError(
        target === "TABLE"
          ? `${menuItem.name}은(는) 카운터에서만 판매하는 상품이에요.`
          : `${menuItem.name}은(는) 테이블 주문 전용 상품이에요.`,
      );
    }
    // 공용 물품에 연결된 메뉴는 물품 상태를 봐야 한다 — 원시 컬럼만 보면
    // "물품을 품절했는데 메뉴는 그대로 주문되는" 구멍이 생긴다.
    if (isSoldOut(menuItem)) {
      throw new OrderValidationError(`${menuItem.name}은(는) 품절되었습니다.`, "MENU_SOLD_OUT");
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
      throw new OrderValidationError("수량이 올바르지 않습니다.");
    }

    const options = validateItemOptions(menuItem, item.optionChoiceIds, optionChoiceMap);
    const optionsTotal = options.reduce((sum, o) => sum + o.extraPriceSnapshot, 0);

    return {
      menuItemId: menuItem.id,
      nameSnapshot: menuItem.name,
      unitPrice: menuItem.price,
      quantity: item.quantity,
      servingMode: servingModeOf(menuItem),
      options,
      lineTotal: (menuItem.price + optionsTotal) * item.quantity,
    };
  });
}

/**
 * 주문 생성. 가격/옵션/품절 여부는 전부 서버가 DB에서 다시 계산하며,
 * 클라이언트가 보낸 가격/합계는 절대 신뢰하지 않는다(docs/SECURITY.md §1).
 */
export async function createOrder(input: CreateOrderInput) {
  // (tableSessionId, clientKey) 조합을 UNIQUE 제약으로 묶어 더블탭/재전송 중복을 원자적으로 차단한다.
  const idempotencyKey = `${input.tableSessionId}:${input.clientIdempotencyKey}`;

  const existing = await prisma.order.findUnique({
    where: { idempotencyKey },
    include: { items: { include: { options: true } } },
  });
  if (existing) return existing;

  const lines = await resolveOrderLines(input.items, "TABLE");

  if (input.expectedTotal !== undefined) {
    const serverTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    if (serverTotal !== input.expectedTotal) {
      throw new OrderValidationError(
        `금액이 바뀌었어요. 화면을 새로고침한 뒤 다시 주문해 주세요(표시 ${input.expectedTotal.toLocaleString()}원 / 실제 ${serverTotal.toLocaleString()}원).`,
        "PRICE_MISMATCH",
      );
    }
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          tableSessionId: input.tableSessionId,
          idempotencyKey,
          note: input.note?.slice(0, 200),
          items: {
            create: lines.map((item) => ({
              menuItemId: item.menuItemId,
              nameSnapshot: item.nameSnapshot,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
              servingMode: item.servingMode,
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
/**
 * 주방/서빙 화면이 쓰는 include. 현장 거래 주문은 tableSession이 null이므로 counterSale까지 함께 읽어
 * "현장 주문 #번호"로 표시할 수 있게 한다(요구사항.md §5.4 — 테이블 번호 null로 화면이 깨지면 안 된다).
 */
const ORDER_WITH_TABLE_INCLUDE = {
  items: { include: { options: true } },
  tableSession: { include: { table: true } },
  counterSale: { select: { id: true, saleNo: true, status: true } },
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
    counterSaleId: updated.counterSaleId,
    orderId: updated.id,
    status: updated.status,
  });
  return updated;
}

/**
 * 테이블 주문에만 의미가 있는 자동 정산 평가. 현장 거래 주문(tableSessionId=null)은
 * 테이블 상태 머신을 전혀 건드리지 않는다(요구사항.md §5.4 — 테이블 배정/자동 종료 로직 실행 금지).
 *
 * **취소/거부 경로에서는 이 함수를 부르지 않는다.** 주문 상태 전이와 테이블 상태 전이는 서로 다른
 * 관심사이고, 주방에서 주문을 취소한 것이 테이블을 닫는 근거가 될 수는 없다.
 * 서빙 완료(markServed)만 "완납 후 마지막 미서빙 주문이 끝났다"는 정산 완료 신호이므로 남겨 둔다.
 */
async function settleIfTableOrder(order: { tableSessionId: string | null }) {
  if (!order.tableSessionId) return;
  await maybeAutoSettleTableSession(order.tableSessionId);
}

export function acceptOrder(orderId: string, staffId: string) {
  return applyTransition(orderId, ["NEW"], "ACCEPTED", { acceptedAt: new Date() }, staffId, "ORDER_ACCEPTED");
}

export async function rejectOrder(orderId: string, staffId: string, reason: string) {
  // 거부는 주문 하나의 상태만 바꾼다 — 테이블 상태는 건드리지 않는다.
  // 거부로 미수금이 0이 되더라도 테이블을 닫는 것은 FRONT의 명시적인 종료/정산 작업이다.
  return applyTransition(orderId, ["NEW"], "REJECTED", { rejectReason: reason }, staffId, "ORDER_REJECTED", { reason });
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
  await settleIfTableOrder(order);
  return order;
}

/** 잘못 누른 서빙 완료를 되돌린다. 시간 제한/권한 정책은 라우트(SERVING) 레벨에서 강제한다. */
export function revertServedToReady(orderId: string, staffId: string) {
  return applyTransition(orderId, ["SERVED"], "READY", { servedAt: null }, staffId, "ORDER_SERVED_REVERTED");
}

/** 주방 취소 사유(요구사항 2절). 화면 문구는 CANCEL_REASON_LABEL이 담당한다. */
export const CANCEL_REASON_CODES = ["OUT_OF_STOCK", "CUSTOMER_REQUEST", "CANNOT_COOK", "WRONG_ORDER", "OTHER"] as const;
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

export const CANCEL_REASON_LABEL: Record<CancelReasonCode, string> = {
  OUT_OF_STOCK: "재료 소진",
  CUSTOMER_REQUEST: "고객 요청",
  CANNOT_COOK: "조리 불가",
  WRONG_ORDER: "잘못된 주문",
  OTHER: "기타",
};

export interface CancelOrderInput {
  orderId: string;
  staffId: string;
  reasonCode: CancelReasonCode;
  note?: string;
  /** 비우면 주문 전체 취소. 채우면 **그 항목만** 취소한다(요구사항 1절). */
  orderItemIds?: string[];
  /** 재료 소진일 때 함께 품절 처리할 대상(요구사항 2절). 같은 트랜잭션에서 처리된다. */
  soldOutTargets?: SoldOutTarget[];
}

/**
 * 주문/주문 항목 취소(요구사항 1·2절).
 *
 * 한 트랜잭션 안에서 처리한다: 항목/주문 취소 → 사유·메모 저장 → 선택한 품목 품절 →
 * 감사 로그. 품절 처리가 실패하면 취소도 함께 롤백되므로 "주문만 취소되고 품절은 안 된" 상태가 없다.
 *
 * **테이블 상태는 건드리지 않는다.** 취소는 주문의 일이고 테이블 종료는 FRONT의 명시적 작업이다.
 *
 * 멱등성: 이미 취소된 항목/주문에 다시 요청해도 상태가 깨지지 않고 현재 상태를 그대로 돌려준다.
 */
export async function cancelOrder(input: CancelOrderInput) {
  const { orderId, staffId, reasonCode, note } = input;
  const reasonLabel = CANCEL_REASON_LABEL[reasonCode];
  const reasonText = note?.trim() ? `${reasonLabel} · ${note.trim()}` : reasonLabel;

  const result = await withWriteConflictRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
        if (!order) throw new OrderStateError("존재하지 않는 주문입니다.", 404);

        const targetItemIds = input.orderItemIds?.length
          ? input.orderItemIds
          : order.items.map((item) => item.id);

        // 요청한 항목이 정말 이 주문의 것인지 확인한다(다른 주문 항목을 끼워 넣어 취소할 수 없다).
        const ownIds = new Set(order.items.map((i) => i.id));
        const foreign = targetItemIds.filter((id) => !ownIds.has(id));
        if (foreign.length > 0) throw new OrderStateError("이 주문에 없는 항목이 포함돼 있어요.", 400);

        const cancelWholeOrder = targetItemIds.length === order.items.length;
        const now = new Date();

        if (cancelWholeOrder) {
          // 전체 취소는 주문 상태 전이로 처리한다. 이미 CANCELLED면 count=0이 되어 멱등하게 넘어간다.
          if (!["NEW", "ACCEPTED", "PREPARING", "CANCELLED"].includes(order.status)) {
            throw new OrderStateError(`현재 상태(${order.status})에서는 취소할 수 없어요.`);
          }
          await tx.order.updateMany({
            where: { id: orderId, status: { in: ["NEW", "ACCEPTED", "PREPARING"] } },
            data: {
              status: "CANCELLED",
              cancelledAt: now,
              cancelReason: reasonText,
              cancelReasonCode: reasonCode,
              cancelNote: note?.slice(0, 200) ?? null,
              cancelledById: staffId,
            },
          });
        }

        // 항목 단위 취소는 항상 기록한다(전체 취소일 때도 어떤 항목이 취소됐는지 남는다).
        await tx.orderItem.updateMany({
          where: { id: { in: targetItemIds }, cancelledAt: null },
          data: { cancelledAt: now, cancelledById: staffId, cancelReason: reasonText },
        });

        // 부분 취소로 **남은 항목이 모두 취소됐다면** 주문 자체도 취소로 맞춘다.
        if (!cancelWholeOrder) {
          const liveCount = await tx.orderItem.count({ where: { orderId, cancelledAt: null } });
          if (liveCount === 0) {
            await tx.order.updateMany({
              where: { id: orderId, status: { in: ["NEW", "ACCEPTED", "PREPARING"] } },
              data: {
                status: "CANCELLED",
                cancelledAt: now,
                cancelReason: reasonText,
                cancelReasonCode: reasonCode,
                cancelNote: note?.slice(0, 200) ?? null,
                cancelledById: staffId,
              },
            });
          }
        }

        // 재료 소진 품절 처리 — 실패하면 위의 취소까지 전부 롤백된다.
        const soldOut = input.soldOutTargets?.length
          ? await applySoldOutInTx(tx, input.soldOutTargets, true, staffId)
          : null;

        const updated = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { items: { include: { options: true } } },
        });
        return { order: updated, soldOut, cancelledItemIds: targetItemIds };
      },
      { maxWait: 10_000, timeout: 20_000 },
    ),
  );

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action: "ORDER_CANCELLED",
    targetType: "Order",
    targetId: orderId,
    metadata: {
      tableSessionId: result.order.tableSessionId,
      counterSaleId: result.order.counterSaleId,
      reasonCode,
      reason: reasonLabel,
      note: note ?? null,
      cancelledOrderItemIds: result.cancelledItemIds,
      cancelledItems: result.order.items
        .filter((i) => result.cancelledItemIds.includes(i.id))
        .map((i) => `${i.nameSnapshot}×${i.quantity}`),
      orderStatusAfter: result.order.status,
      soldOut: result.soldOut,
    },
  });

  appEvents.emit(RealtimeEvent.OrderStatusChanged, {
    tableSessionId: result.order.tableSessionId,
    counterSaleId: result.order.counterSaleId,
    orderId: result.order.id,
    status: result.order.status,
  });
  if (result.soldOut) emitAvailabilityChanged();

  // 테이블 상태는 의도적으로 건드리지 않는다 — 위 함수 주석 참고.
  return result.order;
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
