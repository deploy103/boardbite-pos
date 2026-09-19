import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { staffGate, requireStepUp } from "../middleware/requireRole.js";
import {
  openTable,
  closeTable,
  extendGameTime,
  rotateJoinCode,
  evaluateCloseBlockers,
  TableSessionError,
  TableCloseBlockedError,
  currentGameEndsAt,
} from "../services/tableSession.js";
import { computeBill, computeItemPaymentStatus } from "../services/billing.js";
import { createPayment, createDiscount, voidPayment, PaymentValidationError } from "../services/payment.js";
import { splitEvenly } from "../services/splitEvenly.js";

export const frontRouter = Router();
frontRouter.use(staffGate("FRONT"));

frontRouter.get("/game-plans", async (_req, res) => {
  const plans = await prisma.gameTimePlan.findMany({ where: { isActive: true }, orderBy: { minutes: "asc" } });
  res.json({ plans });
});

frontRouter.get("/tables", async (_req, res) => {
  const tables = await prisma.table.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      sessions: {
        where: { status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
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
        return {
          id: table.id,
          number: table.number,
          name: table.name,
          status: table.status,
          ordersLocked: table.ordersLocked,
          paymentsLocked: table.paymentsLocked,
        };
      }
      const bill = await computeBill(activeSession.id);
      return {
        id: table.id,
        number: table.number,
        name: table.name,
        status: table.status,
        ordersLocked: table.ordersLocked,
        paymentsLocked: table.paymentsLocked,
        session: {
          id: activeSession.id,
          status: activeSession.status,
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
    const { session, joinCode, gameEndsAt } = await openTable({
      tableId: req.params.tableId,
      openedById: req.staff!.id,
      ...parsed.data,
    });
    // 평문 join code는 DB에 남지 않으므로 이 응답이 유일한 전달 경로다.
    // FRONT는 이 값을 손님에게 즉시 안내해야 한다(요구사항2.md §2.2 FRONT UI).
    res.status(201).json({ session, joinCode, gameEndsAt });
  } catch (err) {
    if (err instanceof TableSessionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const closeSchema = z.object({ reason: z.string().max(200).optional() });

/**
 * 종료 버튼을 누르기 전에 무엇이 막고 있는지 미리 보여주기 위한 조회(요구사항2.md §3.1).
 * 실제 차단은 close API가 트랜잭션 안에서 다시 판단하므로, 여기서는 UX용 힌트만 제공한다.
 */
frontRouter.get("/tables/:tableId/close-preflight", async (req, res) => {
  const session = await prisma.tableSession.findFirst({
    where: { tableId: req.params.tableId, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
    orderBy: { openedAt: "desc" },
  });
  if (!session) {
    res.status(404).json({ error: "진행 중인 테이블 세션이 없어요." });
    return;
  }
  const blockers = await evaluateCloseBlockers(session.id);
  res.json({ canClose: blockers.length === 0, blockers });
});

/**
 * FRONT 일반 종료. 더 이상 force로 실행되지 않는다(요구사항2.md §3.1) —
 * 미결제/미서빙/미처리 호출이 남아 있으면 409와 함께 구체적인 사유를 돌려준다.
 * 그래도 종료해야 하는 예외 상황은 ADMIN 강제 종료(admin.routes.ts)로만 가능하다.
 */
frontRouter.post("/tables/:tableId/close", async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const session = await closeTable({
      tableId: req.params.tableId,
      closedById: req.staff!.id,
      reason: parsed.data.reason,
      force: false,
    });
    res.json({ session });
  } catch (err) {
    if (err instanceof TableCloseBlockedError) {
      res.status(err.status).json({ error: err.message, code: "CLOSE_BLOCKED", blockers: err.blockers });
      return;
    }
    if (err instanceof TableSessionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * join code 재발급. 평문을 저장하지 않으므로 "손님이 코드를 잊었다"는 상황의 유일한 복구 수단이다.
 * 이미 입장한 기기는 그대로 쓰고, 새로 입장하는 기기만 새 코드를 사용한다.
 */
frontRouter.post("/table-sessions/:tableSessionId/rotate-join-code", async (req, res) => {
  try {
    const joinCode = await rotateJoinCode({
      tableSessionId: req.params.tableSessionId,
      staffId: req.staff!.id,
    });
    res.json({ joinCode });
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
      staffId: req.staff!.id,
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

// ---------------------------------------------------------------------------
// 정산/결제 (Phase 5). docs/RESEARCH.md Agent E, docs/adr/0005-sqlite-write-concurrency.md 참고.
// ---------------------------------------------------------------------------

frontRouter.get("/payment-methods", async (_req, res) => {
  const methods = await prisma.paymentMethod.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
  res.json({ methods });
});

/** 정산 화면(/front/checkout/:session)에 필요한 모든 정보를 한 번에 내려준다. */
frontRouter.get("/table-sessions/:tableSessionId/checkout", async (req, res) => {
  const tableSessionId = req.params.tableSessionId;
  const session = await prisma.tableSession.findUnique({
    where: { id: tableSessionId },
    include: { table: true },
  });
  if (!session) {
    res.status(404).json({ error: "존재하지 않는 테이블 세션이에요." });
    return;
  }

  const [bill, orders, payments] = await Promise.all([
    computeBill(tableSessionId),
    prisma.order.findMany({
      where: { tableSessionId, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "asc" },
      include: { items: { include: { options: true } } },
    }),
    prisma.payment.findMany({
      where: { tableSessionId },
      orderBy: { createdAt: "asc" },
      include: { allocations: true, createdBy: { select: { displayName: true } } },
    }),
  ]);

  const allOrderItemIds = orders.flatMap((o) => o.items.map((i) => i.id));
  const itemStatus = await computeItemPaymentStatus(allOrderItemIds);

  const ordersWithPaymentStatus = orders.map((order) => ({
    ...order,
    items: order.items.map((item) => ({
      ...item,
      paidQuantity: itemStatus.get(item.id)?.paidQuantity ?? 0,
      remainingQuantity: itemStatus.get(item.id)?.remainingQuantity ?? item.quantity,
    })),
  }));

  res.json({
    table: { id: session.table.id, number: session.table.number, paymentsLocked: session.table.paymentsLocked },
    session: { id: session.id, status: session.status },
    bill,
    orders: ordersWithPaymentStatus,
    payments,
  });
});

const splitQuerySchema = z.object({ people: z.coerce.number().int().min(1).max(50) });

frontRouter.get("/table-sessions/:tableSessionId/split-suggestion", async (req, res) => {
  const parsed = splitQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "인원수를 확인해 주세요." });
    return;
  }
  const bill = await computeBill(req.params.tableSessionId);
  const owed = Math.max(bill.remainingAmount, 0);
  const shares = splitEvenly(owed, parsed.data.people);
  res.json({ totalAmount: owed, people: parsed.data.people, shares });
});

const createPaymentSchema = z.object({
  idempotencyKey: z.string().min(1).max(100),
  methodCode: z.string().min(1).max(30),
  mode: z.enum(["AMOUNT", "ITEMS"]),
  amount: z.number().int().positive().optional(),
  tenderedAmount: z.number().int().positive().optional(),
  allocations: z
    .array(z.object({ orderItemId: z.string().min(1), quantity: z.number().int().positive() }))
    .max(200)
    .optional(),
  payerLabel: z.string().max(50).optional(),
});

frontRouter.post("/table-sessions/:tableSessionId/payments", async (req, res) => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않아요." });
    return;
  }
  if (parsed.data.mode === "ITEMS" && (!parsed.data.allocations || parsed.data.allocations.length === 0)) {
    res.status(400).json({ error: "결제할 상품을 선택해 주세요." });
    return;
  }
  try {
    const result = await createPayment({
      tableSessionId: req.params.tableSessionId,
      idempotencyKey: parsed.data.idempotencyKey,
      methodCode: parsed.data.methodCode,
      mode: parsed.data.mode,
      amount: parsed.data.amount,
      tenderedAmount: parsed.data.tenderedAmount,
      allocations: parsed.data.allocations,
      payerLabel: parsed.data.payerLabel,
      createdById: req.staff!.id,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof PaymentValidationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const createDiscountSchema = z.object({
  idempotencyKey: z.string().min(1).max(100),
  amount: z.number().int().positive(),
  reason: z.string().min(1).max(200),
});

frontRouter.post("/table-sessions/:tableSessionId/discount", async (req, res) => {
  const parsed = createDiscountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "할인 금액과 사유를 입력해 주세요." });
    return;
  }
  try {
    const result = await createDiscount({
      tableSessionId: req.params.tableSessionId,
      idempotencyKey: parsed.data.idempotencyKey,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
      createdById: req.staff!.id,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof PaymentValidationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const voidPaymentSchema = z.object({ reason: z.string().min(1).max(200) });

/**
 * 결제 취소(VOID) / 환불(REFUND). 돈을 되돌리는 작업이라 요구사항2.md §2.5.2의 고위험 목록에 있다 —
 * 사유 입력에 더해 최근 5분 이내의 step-up 재인증(비밀번호, MFA 계정은 TOTP까지)을 요구한다.
 */
frontRouter.post("/payments/:paymentId/void", requireStepUp, async (req, res) => {
  const parsed = voidPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "취소 사유를 입력해 주세요." });
    return;
  }
  try {
    const result = await voidPayment(req.params.paymentId, req.staff!.id, parsed.data.reason);
    res.json(result);
  } catch (err) {
    if (err instanceof PaymentValidationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});
