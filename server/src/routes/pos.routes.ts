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
} from "../services/order.js";

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

posRouter.post("/orders/:id/cancel", async (req, res) => {
  const parsed = reasonSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "취소 사유를 선택해 주세요." });
    return;
  }
  try {
    const order = await cancelOrder(req.params.id, req.staff!.id, parsed.data.reason);
    res.json({ order });
  } catch (err) {
    if (err instanceof OrderStateError) {
      res.status(err.status).json({ error: err.message });
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
