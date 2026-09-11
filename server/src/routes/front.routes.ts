import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireRole } from "../middleware/requireRole.js";
import { openTable, closeTable, extendGameTime, TableSessionError, currentGameEndsAt } from "../services/tableSession.js";
import { computeBill } from "../services/billing.js";

export const frontRouter = Router();
frontRouter.use(requireRole("FRONT"));

frontRouter.get("/game-plans", async (_req, res) => {
  const plans = await prisma.gameTimePlan.findMany({ where: { isActive: true }, orderBy: { minutes: "asc" } });
  res.json({ plans });
});

frontRouter.get("/tables", async (_req, res) => {
  const tables = await prisma.table.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      sessions: {
        where: { status: "ACTIVE" },
        orderBy: { openedAt: "desc" },
        take: 1,
        include: { gameUsages: true },
      },
    },
  });

  const result = await Promise.all(
    tables.map(async (table) => {
      const activeSession = table.sessions[0];
      if (!activeSession) {
        return { id: table.id, number: table.number, name: table.name, status: table.status };
      }
      const bill = await computeBill(activeSession.id);
      return {
        id: table.id,
        number: table.number,
        name: table.name,
        status: table.status,
        session: {
          id: activeSession.id,
          guestCount: activeSession.guestCount,
          openedAt: activeSession.openedAt,
          gameEndsAt: currentGameEndsAt(activeSession.gameUsages),
        },
        bill,
      };
    }),
  );

  res.json({ tables: result });
});

const openSchema = z.object({
  guestCount: z.number().int().min(1).max(50).optional(),
  note: z.string().max(200).optional(),
  gameTimePlanId: z.string().optional(),
});

frontRouter.post("/tables/:tableId/open", async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const session = await openTable({
      tableId: req.params.tableId,
      openedById: req.session.staffUserId!,
      ...parsed.data,
    });
    res.status(201).json({ session });
  } catch (err) {
    if (err instanceof TableSessionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const closeSchema = z.object({ reason: z.string().max(200).optional() });

frontRouter.post("/tables/:tableId/close", async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const session = await closeTable({
      tableId: req.params.tableId,
      closedById: req.session.staffUserId!,
      reason: parsed.data.reason,
      force: true,
    });
    res.json({ session });
  } catch (err) {
    if (err instanceof TableSessionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const extendSchema = z.object({ planId: z.string().min(1) });

frontRouter.post("/table-sessions/:tableSessionId/extend-game", async (req, res) => {
  const parsed = extendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const usage = await extendGameTime({
      tableSessionId: req.params.tableSessionId,
      planId: parsed.data.planId,
      staffId: req.session.staffUserId!,
    });
    res.status(201).json({ usage });
  } catch (err) {
    if (err instanceof TableSessionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

frontRouter.get("/table-sessions/:tableSessionId/orders", async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { tableSessionId: req.params.tableSessionId },
    orderBy: { createdAt: "desc" },
    include: { items: { include: { options: true } } },
  });
  res.json({ orders });
});
