import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { staffGate } from "../middleware/requireRole.js";
import { recordAuditLog } from "../services/auditLog.js";
import {
  acceptOrder,
  rejectOrder,
  startPreparing,
  markReady,
  cancelOrder,
  listOrdersForKitchen,
  searchOrderHistory,
  OrderStateError,
  CANCEL_REASON_CODES,
  CANCEL_REASON_LABEL,
} from "../services/order.js";
import { InventoryError, computeSoldOutImpact, setSoldOut } from "../services/inventory.js";

export const posRouter = Router();
posRouter.use(staffGate("POS"));

posRouter.get("/menu-items", async (_req, res) => {
  const items = await prisma.menuItem.findMany({
    where: { isActive: true, deletedAt: null },
    orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }],
    include: { category: true },
  });
  res.json({ items });
});

posRouter.get("/board", async (_req, res) => {
  const grouped = await listOrdersForKitchen();
  res.json({ orders: grouped });
});

const historyQuerySchema = z.object({
  status: z.enum(["NEW", "ACCEPTED", "PREPARING", "READY", "SERVED", "REJECTED", "CANCELLED"]).optional(),
  tableNumber: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

posRouter.get("/history", async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "검색 조건이 올바르지 않아요." });
    return;
  }
  const orders = await searchOrderHistory(parsed.data);
  res.json({ orders });
});

function handleTransition(fn: (orderId: string, staffId: string, ...rest: string[]) => Promise<unknown>) {
  return async (req: import("express").Request, res: import("express").Response) => {
    try {
      const order = await fn(req.params.id, req.staff!.id, req.body?.reason);
      res.json({ order });
    } catch (err) {
      if (err instanceof OrderStateError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  };
}

posRouter.post("/orders/:id/accept", handleTransition((id, staffId) => acceptOrder(id, staffId)));
posRouter.post("/orders/:id/start-preparing", handleTransition((id, staffId) => startPreparing(id, staffId)));
posRouter.post("/orders/:id/ready", handleTransition((id, staffId) => markReady(id, staffId)));

const reasonSchema = z.object({ reason: z.string().min(1).max(200) });

posRouter.post("/orders/:id/reject", async (req, res) => {
  const parsed = reasonSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "거부 사유를 선택해 주세요." });
    return;
  }
  try {
    const order = await rejectOrder(req.params.id, req.staff!.id, parsed.data.reason);
    res.json({ order });
  } catch (err) {
    if (err instanceof OrderStateError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** 화면이 사유 목록을 하드코딩하지 않도록 서버가 내려준다. */
posRouter.get("/cancel-reasons", (_req, res) => {
  res.json({ reasons: CANCEL_REASON_CODES.map((code) => ({ code, label: CANCEL_REASON_LABEL[code] })) });
});

const soldOutTargetSchema = z.object({
  kind: z.enum(["MENU_ITEM", "OPTION_CHOICE"]),
  id: z.string().min(1),
});

/**
 * 재료 소진 모달이 확인 전에 "무엇이 함께 품절되는지" 보여주기 위한 조회.
 * **아무 상태도 바꾸지 않는다.**
 */
posRouter.post("/sold-out-impact", async (req, res) => {
  const parsed = z.object({ targets: z.array(soldOutTargetSchema).min(1).max(50) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "대상을 확인해 주세요." });
    return;
  }
  try {
    res.json({ impact: await computeSoldOutImpact(parsed.data.targets) });
  } catch (err) {
    if (err instanceof InventoryError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

const cancelSchema = z.object({
  reasonCode: z.enum(CANCEL_REASON_CODES),
  note: z.string().max(200).optional(),
  /** 비우면 주문 전체 취소, 채우면 그 항목만 취소. */
  orderItemIds: z.array(z.string().min(1)).max(100).optional(),
  /** 재료 소진일 때 함께 품절할 대상. 취소와 같은 트랜잭션에서 처리된다. */
  soldOutTargets: z.array(soldOutTargetSchema).max(50).optional(),
});

/**
 * 주문/주문 항목 취소(요구사항 1·2절).
 * 취소는 주문 상태만 바꾼다 — 테이블을 닫거나 정산 완료로 바꾸지 않는다.
 */
posRouter.post("/orders/:id/cancel", async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "취소 사유를 선택해 주세요." });
    return;
  }
  // 재료 소진을 골랐으면 어떤 품목이 떨어졌는지 반드시 지정해야 한다(요구사항 2절).
  if (parsed.data.reasonCode === "OUT_OF_STOCK" && !parsed.data.soldOutTargets?.length) {
    res.status(400).json({ error: "품절된 메뉴나 옵션을 하나 이상 선택해 주세요.", code: "SOLD_OUT_TARGET_REQUIRED" });
    return;
  }
  try {
    const order = await cancelOrder({
      orderId: req.params.id,
      staffId: req.staff!.id,
      reasonCode: parsed.data.reasonCode,
      note: parsed.data.note,
      orderItemIds: parsed.data.orderItemIds,
      soldOutTargets: parsed.data.soldOutTargets,
    });
    res.json({ order });
  } catch (err) {
    if (err instanceof OrderStateError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof InventoryError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

const posSoldOutSchema = z.object({
  targets: z.array(soldOutTargetSchema).min(1).max(50),
  soldOut: z.boolean(),
});

/** 주방에서 직접 품절/판매 재개. 공용 물품에 연결돼 있으면 모든 화면에 동시에 반영된다. */
posRouter.post("/sold-out", async (req, res) => {
  const parsed = posSoldOutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "품절 대상을 확인해 주세요." });
    return;
  }
  try {
    res.json(await setSoldOut(parsed.data.targets, parsed.data.soldOut, req.staff!.id));
  } catch (err) {
    if (err instanceof InventoryError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
});

const soldOutSchema = z.object({ isSoldOut: z.boolean() });

// POS는 "허용 범위 내 품절 처리"만 가능하다(요구사항.md §2.3) — 가격/이름 등은 ADMIN 전용(admin.routes.ts).
posRouter.patch("/menu-items/:id/sold-out", async (req, res) => {
  const parsed = soldOutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않아요." });
    return;
  }
  const item = await prisma.menuItem.findUnique({ where: { id: req.params.id } });
  if (!item || item.deletedAt) {
    res.status(404).json({ error: "존재하지 않는 메뉴예요." });
    return;
  }
  const updated = await prisma.menuItem.update({
    where: { id: item.id },
    data: { isSoldOut: parsed.data.isSoldOut },
  });
  if (parsed.data.isSoldOut !== item.isSoldOut) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "MENU_SOLD_OUT",
      targetType: "MenuItem",
      targetId: item.id,
      metadata: { isSoldOut: parsed.data.isSoldOut },
    });
  }
  res.json({ item: updated });
});
