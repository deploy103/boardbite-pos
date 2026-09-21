import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import type { Db } from "./billing.js";

/**
 * 메뉴 판매 채널 / 제공 방식의 단일 정의(요구사항.md §4, §5.3, §5.4).
 *
 * 채널
 *   TABLE : 테이블 주문 전용 — 손님 화면에 보이고 FRONT 현장 결제에는 뜨지 않는다.
 *   FRONT : FRONT 현장 결제 전용 — 손님 화면/손님 API에서 완전히 차단된다(룰렛/보드게임/닌텐도 등).
 *   BOTH  : 공통. 기존 메뉴는 migration에서 전부 BOTH가 되어 기존 동작이 유지된다.
 *
 * 제공 방식(needsCooking / showInKitchen)
 *   needsCooking=true  → 조리가 필요하다. KDS 조리 대기를 만들고 READY 이후 수령/서빙을 거친다.
 *                        이 경우 showInKitchen=false는 "조리가 필요한데 주방에 안 보인다"는 모순이라
 *                        서버가 거부한다.
 *   needsCooking=false, showInKitchen=true  → 조리는 없지만 주방에서 꺼내 전달하는 품목. KDS에 뜬다.
 *   둘 다 false → 현장 즉시 제공. 조리 대기를 만들지 않고 결제 확인이 곧 제공 확정이다.
 */
export type MenuChannel = "TABLE" | "FRONT" | "BOTH";
export const MENU_CHANNELS: MenuChannel[] = ["TABLE", "FRONT", "BOTH"];

export type ServingMode = "KITCHEN" | "COUNTER";

export class MenuCatalogError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** 이 메뉴가 주방(KDS)을 거치는가. 둘 다 false면 현장 즉시 제공 상품이다. */
export function isKitchenItem(item: { needsCooking: boolean; showInKitchen: boolean }): boolean {
  return item.needsCooking || item.showInKitchen;
}

export function servingModeOf(item: { needsCooking: boolean; showInKitchen: boolean }): ServingMode {
  return isKitchenItem(item) ? "KITCHEN" : "COUNTER";
}

/** needsCooking=true인데 showInKitchen=false인 모순 조합을 막는다(요구사항.md §5.4). */
export function assertCookingFlags(needsCooking: boolean, showInKitchen: boolean): void {
  if (needsCooking && !showInKitchen) {
    throw new MenuCatalogError("조리가 필요한 메뉴는 주방 화면에 표시해야 해요. '주방 표시'를 켜거나 '조리 필요'를 꺼 주세요.");
  }
}

export function channelAllows(channel: string, target: "TABLE" | "FRONT"): boolean {
  return channel === "BOTH" || channel === target;
}

/**
 * 지금 팔 수 있는 옵션만 포함하는 include — 삭제/비활성 그룹과 선택지는 전부 빠진다.
 * 손님 메뉴, FRONT 현장 메뉴, 주문 검증이 모두 이 기준을 공유하므로
 * "화면에는 보이는데 주문하면 거부되는" 불일치가 생기지 않는다.
 */
export const LIVE_OPTION_INCLUDE = {
  optionGroups: {
    where: { deletedAt: null, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      choices: {
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        // 품절 전파를 판정하려면 연결된 재고 품목의 현재 상태가 필요하다.
        include: { linkedMenuItem: { select: { id: true, name: true, isSoldOut: true, isActive: true, deletedAt: true } } },
      },
    },
  },
} satisfies Prisma.MenuItemInclude;

/** 관리자 화면용 — 삭제되지 않은 그룹/선택지는 비활성이어도 모두 보여준다(편집 대상이므로). */
export const ADMIN_OPTION_INCLUDE = {
  optionGroups: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      choices: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: { linkedMenuItem: { select: { id: true, name: true, isSoldOut: true, isActive: true, deletedAt: true } } },
      },
    },
  },
} satisfies Prisma.MenuItemInclude;

export type SellableMenuItem = Prisma.MenuItemGetPayload<{ include: typeof LIVE_OPTION_INCLUDE }>;

/**
 * 한 채널에서 지금 판매 가능한 메뉴를 카테고리와 함께 돌려준다.
 * 손님 메뉴(TABLE)와 FRONT 현장 결제(FRONT)가 같은 함수를 쓰므로,
 * "FRONT 전용 상품이 손님에게 새는" 류의 불일치가 생기지 않는다.
 */
export async function listSellableMenu(target: "TABLE" | "FRONT", db: Db = prisma) {
  const categories = await db.menuCategory.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      items: {
        where: {
          isActive: true,
          deletedAt: null,
          channel: target === "TABLE" ? { in: ["TABLE", "BOTH"] } : { in: ["FRONT", "BOTH"] },
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: LIVE_OPTION_INCLUDE,
      },
    },
  });
  // 선택지마다 "지금 품절인가"를 붙여 내려보낸다. 화면은 이 값만 보고 회색 처리하면 된다.
  return categories
    .filter((c) => c.items.length > 0)
    .map((c) => ({ ...c, items: c.items.map(decorateMenuItemOptions) }));
}


// ---------------------------------------------------------------------------
// 옵션 품절 전파 (재고 품목 연결)
//
// 선택지에 메뉴를 연결하면 그 메뉴의 품절 상태를 그대로 따라간다.
// 연결 메뉴가 품절이거나, 판매 중지(isActive=false)이거나, 삭제됐으면 그 선택지는 고를 수 없다.
//
// "품절"과 "비활성"은 다르다:
//   품절  = 손님에게 **보이지만** 회색으로 선택 불가. 재료가 떨어졌을 뿐 메뉴 구성은 그대로다.
//   비활성 = 아예 보이지 않는다(운영에서 내린 선택지).
// ---------------------------------------------------------------------------

export interface StockLink {
  linkedMenuItem?: { id: string; name: string; isSoldOut: boolean; isActive: boolean; deletedAt: Date | null } | null;
}

/** 연결된 재고 품목 때문에 지금 고를 수 없는 선택지인가. 연결이 없으면 항상 false. */
export function isChoiceSoldOut(choice: StockLink): boolean {
  const linked = choice.linkedMenuItem;
  if (!linked) return false;
  return linked.isSoldOut || !linked.isActive || linked.deletedAt !== null;
}

/** 손님/FRONT 화면에 내려보낼 형태로 선택지에 품절 상태를 붙인다. */
export function decorateChoice<T extends StockLink & { id: string }>(choice: T) {
  const soldOut = isChoiceSoldOut(choice);
  return {
    ...choice,
    isSoldOut: soldOut,
    /** 왜 품절인지 — 화면이 "계란 품절"처럼 구체적으로 안내할 수 있게 한다. */
    soldOutReason: soldOut ? (choice.linkedMenuItem?.name ?? null) : null,
  };
}

/** 메뉴 하나의 모든 옵션 선택지에 품절 상태를 붙인다. */
export function decorateMenuItemOptions<
  T extends { optionGroups: { choices: (StockLink & { id: string })[] }[] },
>(item: T) {
  return {
    ...item,
    optionGroups: item.optionGroups.map((group) => ({
      ...group,
      choices: group.choices.map(decorateChoice),
    })),
  };
}

/**
 * "필수 활성 그룹인데 고를 수 있는 선택지가 하나도 없는" 메뉴는 정상 판매할 수 없다(요구사항.md §3.1).
 * 관리자 화면은 이 상태를 경고로 표시하고, 서버는 주문 자체를 거부한다.
 */
export function blockedRequiredGroups(item: SellableMenuItem): string[] {
  // LIVE_OPTION_INCLUDE가 이미 활성 선택지만 담으므로, 비어 있으면 곧 "고를 수 있는 게 없다"는 뜻이다.
  // 선택지가 있어도 **전부 품절**이면 그 필수 그룹은 고를 수 없으므로 마찬가지로 판매 불가다.
  return item.optionGroups
    .filter((group) => group.required && group.choices.every((choice) => isChoiceSoldOut(choice)))
    .map((group) => group.name);
}

// ---------------------------------------------------------------------------
// ADMIN 편집/삭제 (요구사항.md §3.1, §4)
//
// 삭제는 전부 논리 삭제다. 과거 주문 스냅샷·결제·환불·쿠폰 사용 이력이 참조하는 행은
// 절대 물리 삭제하지 않는다. 새 판매 목록에서만 사라진다.
// ---------------------------------------------------------------------------

export interface MenuItemWriteInput {
  categoryId?: string;
  name?: string;
  description?: string | null;
  price?: number;
  isActive?: boolean;
  isSoldOut?: boolean;
  needsCooking?: boolean;
  showInKitchen?: boolean;
  channel?: MenuChannel;
  sortOrder?: number;
}

function assertChannel(channel: string): asserts channel is MenuChannel {
  if (!MENU_CHANNELS.includes(channel as MenuChannel)) {
    throw new MenuCatalogError("판매 채널 값이 올바르지 않아요.");
  }
}

/**
 * 메뉴 편집. 카테고리 이동도 여기서 처리하며, "삭제된 카테고리로 옮기기"는
 * 트랜잭션 안에서 대상 카테고리를 다시 확인해 막는다(요구사항.md §4의 동시 요청 시나리오).
 */
export async function updateMenuItem(id: string, input: MenuItemWriteInput) {
  if (input.channel !== undefined) assertChannel(input.channel);

  return prisma.$transaction(async (tx) => {
    const before = await tx.menuItem.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw new MenuCatalogError("존재하지 않는 메뉴예요.", 404);

    if (input.categoryId && input.categoryId !== before.categoryId) {
      const category = await tx.menuCategory.findUnique({ where: { id: input.categoryId } });
      if (!category || category.deletedAt) {
        throw new MenuCatalogError("옮기려는 카테고리를 찾을 수 없어요. 목록을 새로고침해 주세요.", 409);
      }
    }

    const needsCooking = input.needsCooking ?? before.needsCooking;
    const showInKitchen = input.showInKitchen ?? before.showInKitchen;
    assertCookingFlags(needsCooking, showInKitchen);

    const item = await tx.menuItem.update({
      where: { id },
      data: {
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.isSoldOut !== undefined ? { isSoldOut: input.isSoldOut } : {}),
        ...(input.needsCooking !== undefined ? { needsCooking } : {}),
        ...(input.showInKitchen !== undefined ? { showInKitchen } : {}),
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
    return { before, item };
  });
}

/** 메뉴 논리 삭제. 새 주문에서는 사라지지만 과거 이력은 그대로 남는다. */
export async function deleteMenuItem(id: string) {
  const deleted = await prisma.menuItem.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date(), isActive: false },
  });
  if (deleted.count !== 1) {
    const exists = await prisma.menuItem.findUnique({ where: { id }, select: { id: true } });
    throw new MenuCatalogError(exists ? "이미 삭제된 메뉴예요." : "존재하지 않는 메뉴예요.", exists ? 409 : 404);
  }
  return prisma.menuItem.findUniqueOrThrow({ where: { id } });
}

/**
 * 카테고리 삭제. **소속 메뉴가 하나라도 남아 있으면 삭제하지 않는다**(요구사항.md §4).
 * 연쇄 삭제하지 않으므로 운영자가 먼저 메뉴를 옮기거나 삭제해야 한다.
 * 개수 확인과 삭제를 한 트랜잭션에 넣어, 확인 직후 다른 요청이 메뉴를 옮겨 넣는 경합도 막는다.
 */
export async function deleteMenuCategory(id: string) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.menuCategory.findUnique({ where: { id } });
    if (!category || category.deletedAt) throw new MenuCatalogError("존재하지 않는 카테고리예요.", 404);

    const remaining = await tx.menuItem.count({ where: { categoryId: id, deletedAt: null } });
    if (remaining > 0) {
      throw new MenuCatalogError(
        `이 카테고리에 메뉴가 ${remaining}개 남아 있어요. 다른 카테고리로 옮기거나 메뉴를 먼저 삭제해 주세요.`,
        409,
      );
    }
    return tx.menuCategory.update({ where: { id }, data: { deletedAt: new Date() } });
  });
}

// ---- 옵션 그룹 / 선택지 ----

export interface OptionGroupWriteInput {
  name?: string;
  required?: boolean;
  multiSelect?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}

export async function updateOptionGroup(groupId: string, menuItemId: string, input: OptionGroupWriteInput) {
  const group = await prisma.optionGroup.findUnique({ where: { id: groupId } });
  // 다른 메뉴의 그룹 ID를 넘겨 남의 옵션을 고치는 것을 막는다(소유관계 검증).
  if (!group || group.deletedAt || group.menuItemId !== menuItemId) {
    throw new MenuCatalogError("존재하지 않는 옵션 그룹이에요.", 404);
  }
  return prisma.optionGroup.update({ where: { id: groupId }, data: input });
}

export async function deleteOptionGroup(groupId: string, menuItemId: string) {
  const group = await prisma.optionGroup.findUnique({ where: { id: groupId } });
  if (!group || group.deletedAt || group.menuItemId !== menuItemId) {
    throw new MenuCatalogError("존재하지 않는 옵션 그룹이에요.", 404);
  }
  const now = new Date();
  // 그룹을 지우면 그 선택지도 함께 새 주문 대상에서 빠진다. 과거 주문의 스냅샷은 그대로다.
  await prisma.$transaction([
    prisma.optionChoice.updateMany({ where: { groupId, deletedAt: null }, data: { deletedAt: now } }),
    prisma.optionGroup.update({ where: { id: groupId }, data: { deletedAt: now, isActive: false } }),
  ]);
  return { id: groupId };
}

export interface OptionChoiceWriteInput {
  name?: string;
  extraPrice?: number;
  isActive?: boolean;
  sortOrder?: number;
}

export async function updateOptionChoice(choiceId: string, groupId: string, input: OptionChoiceWriteInput) {
  const choice = await prisma.optionChoice.findUnique({ where: { id: choiceId } });
  if (!choice || choice.deletedAt || choice.groupId !== groupId) {
    throw new MenuCatalogError("존재하지 않는 옵션이에요.", 404);
  }
  if (input.extraPrice !== undefined && input.extraPrice < 0) {
    // 음수 추가금은 곧 우회 할인이다(요구사항2.md §3.3).
    throw new MenuCatalogError("옵션 추가금은 0원 이상이어야 해요.");
  }
  return prisma.optionChoice.update({ where: { id: choiceId }, data: input });
}

export async function deleteOptionChoice(choiceId: string, groupId: string) {
  const choice = await prisma.optionChoice.findUnique({ where: { id: choiceId } });
  if (!choice || choice.deletedAt || choice.groupId !== groupId) {
    throw new MenuCatalogError("존재하지 않는 옵션이에요.", 404);
  }
  await prisma.optionChoice.update({ where: { id: choiceId }, data: { deletedAt: new Date(), isActive: false } });
  return { id: choiceId };
}

/**
 * 관리자 메뉴 목록. 삭제되지 않은 카테고리/메뉴를 옵션까지 포함해 돌려주고,
 * "필수 그룹인데 고를 선택지가 없는" 판매 불가 상태를 함께 표시한다.
 */
export async function listMenuForAdmin() {
  const categories = await prisma.menuCategory.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      items: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: ADMIN_OPTION_INCLUDE,
      },
    },
  });

  return categories.map((category) => ({
    ...category,
    items: category.items.map((item) => ({
      ...decorateMenuItemOptions(item),
      // 필수 그룹인데 고를 수 있는 선택지가 하나도 없는 상태(비활성뿐이거나 전부 품절)를 경고로 띄운다.
      blockedRequiredGroups: item.optionGroups
        .filter(
          (group) =>
            group.isActive &&
            group.required &&
            !group.choices.some((c) => c.isActive && !isChoiceSoldOut(c)),
        )
        .map((group) => group.name),
    })),
  }));
}

// ---------------------------------------------------------------------------
// 표시 순서 (요구사항: 손님에게 보이는 메뉴 순서 / 그룹 순서 / 그룹 내 선택지 순서)
//
// 화면은 ↑↓ 버튼으로 새 순서를 만들어 **목록 전체**를 보낸다. 서버는 그 목록이 정말 해당 부모의
// 것인지 확인한 뒤 sortOrder를 0..n-1로 다시 매긴다. 번호를 직접 입력하다 값이 겹쳐
// 순서가 뒤죽박죽이 되는 일이 없고, 한 트랜잭션이라 중간 상태가 남지 않는다.
// ---------------------------------------------------------------------------

async function applyOrder(
  ids: string[],
  loadCurrentIds: (tx: Prisma.TransactionClient) => Promise<string[]>,
  update: (tx: Prisma.TransactionClient, id: string, sortOrder: number) => Promise<unknown>,
) {
  if (new Set(ids).size !== ids.length) {
    throw new MenuCatalogError("순서 목록에 같은 항목이 두 번 들어 있어요.");
  }
  return prisma.$transaction(async (tx) => {
    const current = await loadCurrentIds(tx);
    const currentSet = new Set(current);
    // 보낸 목록이 현재 목록과 정확히 일치해야 한다 — 다른 메뉴의 항목을 끼워 넣거나
    // 사이에 추가/삭제가 일어난 오래된 화면의 제출을 그대로 받지 않는다.
    if (ids.length !== current.length || ids.some((id) => !currentSet.has(id))) {
      throw new MenuCatalogError("목록이 그 사이에 바뀌었어요. 새로고침한 뒤 다시 정렬해 주세요.", 409);
    }
    for (const [index, id] of ids.entries()) {
      await update(tx, id, index);
    }
    return { count: ids.length };
  });
}

/** 카테고리 안에서 손님에게 보이는 메뉴 순서를 바꾼다. */
export function reorderMenuItems(categoryId: string, itemIds: string[]) {
  return applyOrder(
    itemIds,
    async (tx) =>
      (
        await tx.menuItem.findMany({
          where: { categoryId, deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true },
        })
      ).map((r) => r.id),
    (tx, id, sortOrder) => tx.menuItem.update({ where: { id }, data: { sortOrder } }),
  );
}

/** 한 메뉴 안에서 옵션 그룹이 보이는 순서를 바꾼다. */
export function reorderOptionGroups(menuItemId: string, groupIds: string[]) {
  return applyOrder(
    groupIds,
    async (tx) =>
      (
        await tx.optionGroup.findMany({
          where: { menuItemId, deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true },
        })
      ).map((r) => r.id),
    (tx, id, sortOrder) => tx.optionGroup.update({ where: { id }, data: { sortOrder } }),
  );
}

/** 한 그룹 안에서 선택지가 보이는 순서를 바꾼다. */
export function reorderOptionChoices(groupId: string, choiceIds: string[]) {
  return applyOrder(
    choiceIds,
    async (tx) =>
      (
        await tx.optionChoice.findMany({
          where: { groupId, deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true },
        })
      ).map((r) => r.id),
    (tx, id, sortOrder) => tx.optionChoice.update({ where: { id }, data: { sortOrder } }),
  );
}

/**
 * 옵션 선택지에 재고 품목(메뉴)을 연결하거나 끊는다.
 * 연결하면 그 메뉴가 품절될 때 이 선택지도 자동으로 품절이 된다.
 */
export async function setChoiceStockLink(choiceId: string, groupId: string, linkedMenuItemId: string | null) {
  const choice = await prisma.optionChoice.findUnique({ where: { id: choiceId } });
  if (!choice || choice.deletedAt || choice.groupId !== groupId) {
    throw new MenuCatalogError("존재하지 않는 옵션이에요.", 404);
  }
  if (linkedMenuItemId) {
    const target = await prisma.menuItem.findUnique({ where: { id: linkedMenuItemId } });
    if (!target || target.deletedAt) {
      throw new MenuCatalogError("연결할 메뉴를 찾을 수 없어요.", 404);
    }
  }
  return prisma.optionChoice.update({ where: { id: choiceId }, data: { linkedMenuItemId } });
}
