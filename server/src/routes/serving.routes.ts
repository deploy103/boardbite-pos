import { Router } from "express";
import { prisma } from "../prisma.js";
import { staffGate } from "../middleware/requireRole.js";
import { markServed, revertServedToReady, OrderStateError } from "../services/order.js";
import { getSettings } from "../services/settings.js";
import { recordAuditLog } from "../services/auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";

export const servingRouter = Router();
servingRouter.use(staffGate("SERVING"));

const ORDER_WITH_TABLE_INCLUDE = {
  items: { include: { options: true } },
  tableSession: { include: { table: true } },
} as const;

/**
 * SERVING은 "테이블로 가져다 주는" 화면이다. FRONT 현장 거래 주문(tableSessionId=null)은
 * 손님이 카운터에서 직접 받아가므로 여기 나오지 않고, FRONT의 현장 거래 목록에서
 * 주문번호를 확인해 수령 완료 처리한다(요구사항.md §5.4).
 */
const TABLE_ORDERS_ONLY = { tableSessionId: { not: null } } as const;

servingRouter.get("/ready", async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: "READY", ...TABLE_ORDERS_ONLY },
    orderBy: { readyAt: "asc" },
    include: ORDER_WITH_TABLE_INCLUDE,
  });
  res.json({ orders });
});

/** 최근 서빙완료 이력 — "잘못 눌렀을 때 되돌리기" UI가 대상을 찾을 수 있도록 최근 N건을 함께 보여준다. */
servingRouter.get("/recently-served", async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: "SERVED", ...TABLE_ORDERS_ONLY },
    orderBy: { servedAt: "desc" },
    take: 30,
    include: ORDER_WITH_TABLE_INCLUDE,
  });
  res.json({ orders });
});

servingRouter.post("/orders/:id/served", async (req, res) => {
  try {
    const order = await markServed(req.params.id, req.staff!.id);
    res.json({ order });
  } catch (err) {
    if (err instanceof OrderStateError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

servingRouter.post("/orders/:id/revert", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) {
    res.status(404).json({ error: "존재하지 않는 주문이에요." });
    return;
  }
  // 요구사항.md §2.4 "잘못 누른 서빙 완료 되돌리기(짧은 시간 또는 권한 필요)" — ADMIN은 시간 제한 없이 되돌릴 수 있다.
  if (req.staff!.role !== "ADMIN" && order.servedAt) {
    const settings = await getSettings();
    const elapsedSeconds = (Date.now() - order.servedAt.getTime()) / 1000;
    if (elapsedSeconds > settings.servedRevertWindowSeconds) {
      res.status(403).json({
        error: `서빙완료 후 ${Math.floor(settings.servedRevertWindowSeconds / 60)}분이 지나 되돌릴 수 없어요. 관리자에게 문의해 주세요.`,
      });
      return;
    }
  }

  try {
    const updated = await revertServedToReady(req.params.id, req.staff!.id);
    res.json({ order: updated });
  } catch (err) {
    if (err instanceof OrderStateError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// ---------- 직원 호출 처리 ----------

servingRouter.get("/staff-calls", async (_req, res) => {
  const calls = await prisma.staffCallRequest.findMany({
    where: { status: { in: ["PENDING", "ACKED"] } },
    orderBy: { createdAt: "asc" },
    include: { tableSession: { include: { table: true } } },
  });
  res.json({ calls });
});

/**
 * 호출 접수. 주문 상태 전이와 같은 이유로 조건부 updateMany를 쓴다(요구사항2.md §3.6) —
 * 두 직원이 같은 호출을 동시에 집어도 한 명만 성공한다.
 */
servingRouter.post("/staff-calls/:id/ack", async (req, res) => {
  const claimed = await prisma.staffCallRequest.updateMany({
    where: { id: req.params.id, status: "PENDING" },
    data: { status: "ACKED", ackedAt: new Date() },
  });
  if (claimed.count !== 1) {
    const exists = await prisma.staffCallRequest.findUnique({ where: { id: req.params.id }, select: { id: true } });
    res.status(exists ? 409 : 404).json({
      error: exists ? "이미 처리 중이거나 완료된 호출이에요." : "존재하지 않는 호출이에요.",
    });
    return;
  }
  const updated = await prisma.staffCallRequest.findUniqueOrThrow({ where: { id: req.params.id } });
  appEvents.emit(RealtimeEvent.StaffCallRequested, {
    tableSessionId: updated.tableSessionId,
    callId: updated.id,
    status: "ACKED",
  });
  res.json({ call: updated });
});

servingRouter.post("/staff-calls/:id/done", async (req, res) => {
  const claimed = await prisma.staffCallRequest.updateMany({
    where: { id: req.params.id, status: { in: ["PENDING", "ACKED"] } },
    data: { status: "DONE", doneAt: new Date() },
  });
  if (claimed.count !== 1) {
    const exists = await prisma.staffCallRequest.findUnique({ where: { id: req.params.id }, select: { id: true } });
    res.status(exists ? 409 : 404).json({
      error: exists ? "이미 완료된 호출이에요." : "존재하지 않는 호출이에요.",
    });
    return;
  }
  const call = await prisma.staffCallRequest.findUniqueOrThrow({ where: { id: req.params.id } });
  const updated = call;
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.staff!.id,
    action: "STAFF_CALL_RESOLVED",
    targetType: "StaffCallRequest",
    targetId: call.id,
  });
  appEvents.emit(RealtimeEvent.StaffCallRequested, { tableSessionId: call.tableSessionId, callId: call.id, status: "DONE" });
  res.json({ call: updated });
});
