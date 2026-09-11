import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { isProduction } from "../env.js";
import { requireTableSession, TABLE_SESSION_COOKIE } from "../middleware/requireTableSession.js";
import { createOrder, OrderValidationError } from "../services/order.js";
import { computeBill } from "../services/billing.js";

export const customerRouter = Router();

const TABLE_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12시간 — 자정 넘는 장시간 행사 대비 여유

// 물리 QR/NFC에 인코딩된 고정 slug 진입점. docs/adr/0004-table-token.md
customerRouter.get("/entry/:slug", async (req, res) => {
  const { slug } = req.params;
  const table = await prisma.table.findUnique({ where: { publicSlug: slug } });

  if (!table || table.status !== "OPEN") {
    res.clearCookie(TABLE_SESSION_COOKIE);
    res.json({
      open: false,
      tableNumber: table?.number ?? null,
      message: "현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요.",
    });
    return;
  }

  const session = await prisma.tableSession.findFirst({
    where: { tableId: table.id, status: "ACTIVE" },
    orderBy: { openedAt: "desc" },
  });

  if (!session) {
    res.clearCookie(TABLE_SESSION_COOKIE);
    res.json({
      open: false,
      tableNumber: table.number,
      message: "현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요.",
    });
    return;
  }

  res.cookie(TABLE_SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: TABLE_COOKIE_MAX_AGE_MS,
    path: "/",
  });
  res.json({ open: true, tableNumber: table.number });
});

customerRouter.get("/menu", requireTableSession, async (_req, res) => {
  const categories = await prisma.menuCategory.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        include: { optionGroups: { include: { choices: { where: { isActive: true } } } } },
      },
    },
  });
  res.json({ categories });
});

customerRouter.get("/session", requireTableSession, async (req, res) => {
  const bill = await computeBill(req.tableSession!.id);
  res.json({ tableNumber: req.tableSession!.tableNumber, bill });
});

customerRouter.get("/orders", requireTableSession, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { tableSessionId: req.tableSession!.id },
    orderBy: { createdAt: "desc" },
    include: { items: { include: { options: true } } },
  });
  res.json({ orders });
});

const createOrderSchema = z.object({
  idempotencyKey: z.string().min(1).max(100),
  note: z.string().max(200).optional(),
  items: z
    .array(
      z.object({
        menuItemId: z.string().min(1),
        quantity: z.number().int().min(1).max(50),
        optionChoiceIds: z.array(z.string().min(1)).max(20).default([]),
      }),
    )
    .min(1)
    .max(50),
});

customerRouter.post("/orders", requireTableSession, async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "주문 내용이 올바르지 않습니다." });
    return;
  }

  try {
    const order = await createOrder({
      tableSessionId: req.tableSession!.id,
      clientIdempotencyKey: parsed.data.idempotencyKey,
      items: parsed.data.items,
      note: parsed.data.note,
    });
    res.status(201).json({ order });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});
