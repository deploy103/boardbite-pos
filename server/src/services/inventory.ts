import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { recordAuditLogBestEffort } from "./auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";
import { withWriteConflictRetry } from "./writeConflict.js";
import type { Db } from "./billing.js";

/**
 * 공용 재고 물품(요구사항 4절).
 *
 * 메뉴와 옵션 선택지가 **같은 InventoryItem을 참조**하면 품절 상태를 공유한다.
 * 품절 값을 각자 복사해 두지 않으므로 화면끼리 어긋날 수가 없다:
 *
 *   계란(메뉴) ─┐
 *   라면>계란 추가 ─┼─→ InventoryItem "계란"  ← 여기 하나만 바뀐다
 *   우동>계란 추가 ─┘
 *
 * 연결이 없는 항목은 자체 isSoldOut 플래그로 독립 관리한다(요구사항 4.3).
 * 나중에 물품에 연결하면 그 순간부터 물품 상태를 따른다.
 */

export class InventoryError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
  }
}

/** 품절 판정에 필요한 최소 형태. 메뉴와 옵션 선택지가 같은 규칙을 쓴다. */
export interface SoldOutResolvable {
  isSoldOut: boolean;
  inventoryItem?: { id: string; name: string; isSoldOut: boolean; deletedAt: Date | null } | null;
}

/**
 * 지금 이 항목이 품절인가.
 *
 * 연결된 물품이 있으면 **물품 상태만** 본다(단일 기준). 연결이 없거나 물품이 삭제됐으면
 * 항목 자신의 플래그를 본다. 두 값을 OR로 합치지 않는 이유: 그러면 연결을 끊어도 옛 로컬 값이
 * 살아나 "분명히 판매 재개했는데 여전히 품절"인 상황이 생긴다.
 */
export function isSoldOut(entity: SoldOutResolvable): boolean {
  const linked = entity.inventoryItem;
  if (linked && !linked.deletedAt) return linked.isSoldOut;
  return entity.isSoldOut;
}

/** 품절 사유 표시용 — 공용 물품 때문이면 그 이름을, 아니면 null. */
export function soldOutReasonOf(entity: SoldOutResolvable): string | null {
  const linked = entity.inventoryItem;
  if (linked && !linked.deletedAt && linked.isSoldOut) return linked.name;
  return null;
}

/** 조회에 항상 붙이는 select. 어느 화면에서든 같은 정보로 품절을 판정한다. */
export const INVENTORY_SELECT = {
  inventoryItem: { select: { id: true, name: true, isSoldOut: true, deletedAt: true } },
} as const;

// ---------------------------------------------------------------------------
// 품절 / 판매 재개
// ---------------------------------------------------------------------------

export type SoldOutTargetKind = "MENU_ITEM" | "OPTION_CHOICE";

export interface SoldOutTarget {
  kind: SoldOutTargetKind;
  id: string;
}

/** 한 대상을 품절/재개했을 때 실제로 영향을 받는 범위. 확인 모달이 이 값을 그대로 보여준다. */
export interface SoldOutImpact {
  kind: SoldOutTargetKind;
  id: string;
  name: string;
  /** 공용 물품에 연결돼 있으면 그 물품. 연결이 없으면 null(이 항목에만 영향). */
  inventoryItem: { id: string; name: string } | null;
  alreadySoldOut: boolean;
  /** 이 조작으로 함께 품절되는 메뉴들. */
  affectedMenuItems: { id: string; name: string }[];
  /** 이 조작으로 함께 품절되는 옵션 선택지들(어느 메뉴의 어느 그룹인지 포함). */
  affectedOptionChoices: { id: string; name: string; groupName: string; menuItemName: string }[];
}

/**
 * 영향 범위 계산. **상태를 바꾸지 않는다** — 재료 소진 모달이 확인 전에 보여주는 값이다.
 */
export async function computeSoldOutImpact(targets: SoldOutTarget[], db: Db = prisma): Promise<SoldOutImpact[]> {
  const results: SoldOutImpact[] = [];

  for (const target of targets) {
    let name: string;
    let inventoryItemId: string | null;
    let alreadySoldOut: boolean;

    if (target.kind === "MENU_ITEM") {
      const item = await db.menuItem.findUnique({ where: { id: target.id }, include: INVENTORY_SELECT });
      if (!item || item.deletedAt) throw new InventoryError("존재하지 않는 메뉴예요.", 404, "MENU_NOT_FOUND");
      name = item.name;
      inventoryItemId = item.inventoryItem && !item.inventoryItem.deletedAt ? item.inventoryItem.id : null;
      alreadySoldOut = isSoldOut(item);
    } else {
      const choice = await db.optionChoice.findUnique({
        where: { id: target.id },
        include: { ...INVENTORY_SELECT, group: { include: { menuItem: { select: { name: true } } } } },
      });
      if (!choice || choice.deletedAt) throw new InventoryError("존재하지 않는 옵션이에요.", 404, "CHOICE_NOT_FOUND");
      name = choice.name;
      inventoryItemId = choice.inventoryItem && !choice.inventoryItem.deletedAt ? choice.inventoryItem.id : null;
      alreadySoldOut = isSoldOut(choice);
    }

    // 연결이 없으면 이 항목 하나에만 영향을 준다.
    if (!inventoryItemId) {
      results.push({
        kind: target.kind,
        id: target.id,
        name,
        inventoryItem: null,
        alreadySoldOut,
        affectedMenuItems: target.kind === "MENU_ITEM" ? [{ id: target.id, name }] : [],
        affectedOptionChoices: [],
      });
      continue;
    }

    const inventory = await db.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId } });
    const [menus, choices] = await Promise.all([
      db.menuItem.findMany({ where: { inventoryItemId, deletedAt: null }, select: { id: true, name: true } }),
      db.optionChoice.findMany({
        where: { inventoryItemId, deletedAt: null },
        select: { id: true, name: true, group: { select: { name: true, menuItem: { select: { name: true } } } } },
      }),
    ]);

    results.push({
      kind: target.kind,
      id: target.id,
      name,
      inventoryItem: { id: inventory.id, name: inventory.name },
      alreadySoldOut,
      affectedMenuItems: menus,
      affectedOptionChoices: choices.map((c) => ({
        id: c.id,
        name: c.name,
        groupName: c.group.name,
        menuItemName: c.group.menuItem.name,
      })),
    });
  }

  return results;
}

/**
 * 품절/판매 재개를 **하나의 트랜잭션 안에서** 적용한다.
 *
 * 연결된 물품이 있으면 물품을 바꾼다 — 그래서 어느 화면(메뉴/옵션/현장 판매)에서 눌러도
 * 같은 물품을 쓰는 모든 항목에 동시에 반영된다(요구사항 4.1, 4.2).
 * 연결이 없으면 그 항목의 자체 플래그만 바꾼다(요구사항 4.3).
 *
 * 같은 물품을 두 직원이 동시에 건드려도 마지막 상태와 로그가 일관되도록
 * 쓰기 충돌은 유한 재시도한다.
 */
export async function applySoldOutInTx(
  tx: Prisma.TransactionClient,
  targets: SoldOutTarget[],
  soldOut: boolean,
  staffId: string,
): Promise<{ inventoryItemIds: string[]; menuItemIds: string[]; optionChoiceIds: string[] }> {
  const now = new Date();
  const inventoryItemIds = new Set<string>();
  const menuItemIds = new Set<string>();
  const optionChoiceIds = new Set<string>();

  for (const target of targets) {
    if (target.kind === "MENU_ITEM") {
      const item = await tx.menuItem.findUnique({ where: { id: target.id }, include: INVENTORY_SELECT });
      if (!item || item.deletedAt) throw new InventoryError("존재하지 않는 메뉴예요.", 404, "MENU_NOT_FOUND");
      if (item.inventoryItem && !item.inventoryItem.deletedAt) {
        inventoryItemIds.add(item.inventoryItem.id);
      } else {
        await tx.menuItem.update({ where: { id: item.id }, data: { isSoldOut: soldOut } });
        menuItemIds.add(item.id);
      }
    } else {
      const choice = await tx.optionChoice.findUnique({ where: { id: target.id }, include: INVENTORY_SELECT });
      if (!choice || choice.deletedAt) throw new InventoryError("존재하지 않는 옵션이에요.", 404, "CHOICE_NOT_FOUND");
      if (choice.inventoryItem && !choice.inventoryItem.deletedAt) {
        inventoryItemIds.add(choice.inventoryItem.id);
      } else {
        await tx.optionChoice.update({ where: { id: choice.id }, data: { isSoldOut: soldOut } });
        optionChoiceIds.add(choice.id);
      }
    }
  }

  if (inventoryItemIds.size > 0) {
    await tx.inventoryItem.updateMany({
      where: { id: { in: [...inventoryItemIds] } },
      data: {
        isSoldOut: soldOut,
        soldOutAt: soldOut ? now : null,
        soldOutById: soldOut ? staffId : null,
      },
    });
  }

  return {
    inventoryItemIds: [...inventoryItemIds],
    menuItemIds: [...menuItemIds],
    optionChoiceIds: [...optionChoiceIds],
  };
}

/** 트랜잭션 밖에서 단독으로 품절/재개할 때 쓰는 진입점(관리자/POS 품절 버튼). */
export async function setSoldOut(targets: SoldOutTarget[], soldOut: boolean, staffId: string) {
  if (targets.length === 0) throw new InventoryError("대상을 선택해 주세요.", 400, "NO_TARGET");

  const before = await computeSoldOutImpact(targets);
  const applied = await withWriteConflictRetry(() =>
    prisma.$transaction((tx) => applySoldOutInTx(tx, targets, soldOut, staffId), { maxWait: 10_000, timeout: 20_000 }),
  );

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action: soldOut ? "INVENTORY_SOLD_OUT" : "INVENTORY_RESTOCKED",
    targetType: "InventoryItem",
    targetId: applied.inventoryItemIds[0] ?? targets[0].id,
    metadata: {
      soldOut,
      targets,
      before: before.map((b) => ({ id: b.id, kind: b.kind, name: b.name, wasSoldOut: b.alreadySoldOut })),
      affectedInventoryItemIds: applied.inventoryItemIds,
      affectedMenuItemIds: applied.menuItemIds,
      affectedOptionChoiceIds: applied.optionChoiceIds,
      affectedMenus: before.flatMap((b) => b.affectedMenuItems.map((m) => m.name)),
      affectedOptions: before.flatMap((b) => b.affectedOptionChoices.map((c) => `${c.menuItemName}>${c.name}`)),
    },
  });

  emitAvailabilityChanged();
  return { applied, impact: before };
}

/** 판매 가능 상태가 바뀌었음을 모든 화면에 알린다. 화면은 이 신호를 받아 목록을 다시 읽는다. */
export function emitAvailabilityChanged() {
  appEvents.emit(RealtimeEvent.MenuAvailabilityChanged, {});
}

// ---------------------------------------------------------------------------
// 관리 (요구사항 4.4)
// ---------------------------------------------------------------------------

/** 물품 목록 + 어떤 메뉴/옵션이 이 물품을 공유하는지. */
export async function listInventoryItems() {
  const items = await prisma.inventoryItem.findMany({
    where: { deletedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: {
      soldOutBy: { select: { displayName: true } },
      menuItems: { where: { deletedAt: null }, select: { id: true, name: true } },
      optionChoices: {
        where: { deletedAt: null },
        select: { id: true, name: true, group: { select: { name: true, menuItem: { select: { name: true } } } } },
      },
    },
  });
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    note: item.note,
    isSoldOut: item.isSoldOut,
    soldOutAt: item.soldOutAt,
    soldOutBy: item.soldOutBy?.displayName ?? null,
    menuItems: item.menuItems,
    optionChoices: item.optionChoices.map((c) => ({
      id: c.id,
      name: c.name,
      groupName: c.group.name,
      menuItemName: c.group.menuItem.name,
    })),
    usageCount: item.menuItems.length + item.optionChoices.length,
  }));
}

export async function createInventoryItem(name: string, note: string | undefined, staffId: string) {
  const item = await prisma.inventoryItem.create({ data: { name: name.trim(), note: note?.slice(0, 200) } });
  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action: "INVENTORY_ITEM_CREATED",
    targetType: "InventoryItem",
    targetId: item.id,
    metadata: { name: item.name },
  });
  return item;
}

/**
 * 메뉴/옵션을 공용 물품에 연결하거나 분리한다.
 *
 * 분리할 때는 물품의 현재 품절 상태를 항목의 자체 플래그로 **물려받는다** —
 * 그래야 "연결을 끊었더니 갑자기 판매 가능으로 바뀌는" 놀라움이 없다.
 */
export async function setInventoryLink(target: SoldOutTarget, inventoryItemId: string | null, staffId: string) {
  const result = await prisma.$transaction(async (tx) => {
    if (inventoryItemId) {
      const inventory = await tx.inventoryItem.findUnique({ where: { id: inventoryItemId } });
      if (!inventory || inventory.deletedAt) throw new InventoryError("존재하지 않는 물품이에요.", 404, "INVENTORY_NOT_FOUND");
    }

    if (target.kind === "MENU_ITEM") {
      const item = await tx.menuItem.findUnique({ where: { id: target.id }, include: INVENTORY_SELECT });
      if (!item || item.deletedAt) throw new InventoryError("존재하지 않는 메뉴예요.", 404, "MENU_NOT_FOUND");
      const inherited = inventoryItemId === null ? isSoldOut(item) : item.isSoldOut;
      return tx.menuItem.update({ where: { id: item.id }, data: { inventoryItemId, isSoldOut: inherited } });
    }

    const choice = await tx.optionChoice.findUnique({ where: { id: target.id }, include: INVENTORY_SELECT });
    if (!choice || choice.deletedAt) throw new InventoryError("존재하지 않는 옵션이에요.", 404, "CHOICE_NOT_FOUND");
    const inherited = inventoryItemId === null ? isSoldOut(choice) : choice.isSoldOut;
    return tx.optionChoice.update({ where: { id: choice.id }, data: { inventoryItemId, isSoldOut: inherited } });
  });

  await recordAuditLogBestEffort({
    actorType: "STAFF",
    actorId: staffId,
    action: inventoryItemId ? "INVENTORY_LINKED" : "INVENTORY_UNLINKED",
    targetType: target.kind,
    targetId: target.id,
    metadata: { inventoryItemId },
  });
  emitAvailabilityChanged();
  return result;
}

/**
 * 물품 논리 삭제. 참조가 남아 있으면 먼저 분리하도록 막는다 —
 * 조용히 연결이 끊겨 품절 상태가 흐트러지는 것을 방지한다(요구사항 4.4).
 */
export async function deleteInventoryItem(id: string, staffId: string) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findUnique({ where: { id } });
    if (!item || item.deletedAt) throw new InventoryError("존재하지 않는 물품이에요.", 404, "INVENTORY_NOT_FOUND");
    const [menus, choices] = await Promise.all([
      tx.menuItem.count({ where: { inventoryItemId: id, deletedAt: null } }),
      tx.optionChoice.count({ where: { inventoryItemId: id, deletedAt: null } }),
    ]);
    if (menus + choices > 0) {
      throw new InventoryError(
        `이 물품을 쓰는 메뉴 ${menus}개, 옵션 ${choices}개가 남아 있어요. 먼저 연결을 끊어 주세요.`,
        409,
        "INVENTORY_IN_USE",
      );
    }
    const deleted = await tx.inventoryItem.update({ where: { id }, data: { deletedAt: new Date() } });
    void staffId;
    return deleted;
  });
}
