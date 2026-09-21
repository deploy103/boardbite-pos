import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { isProduction } from "../env.js";
import { requireTableSession, requireOrderableSession } from "../middleware/requireTableSession.js";
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_TTL_MS,
  issueDeviceSession,
  joinCodeMatches,
  resolveCustomerSession,
} from "../services/customerSession.js";
import { createOrder, OrderValidationError } from "../services/order.js";
import { listSellableMenu } from "../services/menuCatalog.js";
import { computeBill } from "../services/billing.js";
import { recordAuditLog, recordAuditLogBestEffort } from "../services/auditLog.js";
import { appEvents, RealtimeEvent } from "../realtime.js";

export const customerRouter = Router();

const CLOSED_MESSAGE = "현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요.";

/**
 * 물리 QR/NFC에 인코딩된 고정 slug 진입점.
 *
 * 요구사항2.md §2.2: 여기서는 **어떤 접근 권한도 발급하지 않는다**. 테이블이 지금 열려 있는지와,
 * 이 브라우저가 이미 유효한 device session을 갖고 있는지만 알려준다. 권한이 없으면 클라이언트가
 * join code 입력 화면을 띄운다.
 */
customerRouter.get("/entry/:slug", async (req, res) => {
  const { slug } = req.params;
  const table = await prisma.table.findUnique({ where: { publicSlug: slug } });

  const session =
    table && (table.status === "OPEN" || table.status === "SETTLING")
      ? await prisma.tableSession.findFirst({
          where: { tableId: table.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
          orderBy: { openedAt: "desc" },
        })
      : null;

  if (!table || !session) {
    res.json({ open: false, joined: false, tableNumber: table?.number ?? null, message: CLOSED_MESSAGE });
    return;
  }

  // 이미 이 세션에 입장한 기기인지 확인한다. 다른 테이블/이전 세션의 쿠키는 joined=false가 된다.
  const existingToken = req.cookies?.[CUSTOMER_SESSION_COOKIE];
  const resolved = typeof existingToken === "string" ? await resolveCustomerSession(existingToken) : null;
  const joined = resolved?.tableSessionId === session.id;

  res.json({ open: true, joined, tableNumber: table.number });
});

const joinSchema = z.object({ joinCode: z.string().min(4).max(10) });

/**
 * join code로 이 세션의 손님 기기 세션을 발급받는다.
 *
 * - 현재 ACTIVE/PAID_PENDING_SERVICE인 세션의 코드만 통한다.
 * - 이전 세션의 코드는 재OPEN 후 절대 통하지 않는다(코드가 세션마다 새로 발급되고
 *   해시가 tableSessionId로 도메인 분리되어 있기 때문).
 * - 실패 메시지는 "코드가 틀렸다" 한 가지로 통일해 코드 존재 여부를 노출하지 않는다.
 * - 무차별 대입은 app.ts의 전용 rate limiter가 IP+테이블 단위로 제한한다.
 */
customerRouter.post("/join/:slug", async (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입장 코드를 입력해 주세요." });
    return;
  }

  const table = await prisma.table.findUnique({ where: { publicSlug: req.params.slug } });
  const session =
    table && (table.status === "OPEN" || table.status === "SETTLING")
      ? await prisma.tableSession.findFirst({
          where: { tableId: table.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
          orderBy: { openedAt: "desc" },
        })
      : null;

  if (!table || !session) {
    res.status(403).json({ error: CLOSED_MESSAGE });
    return;
  }

  const code = parsed.data.joinCode.trim();
  if (!joinCodeMatches(session.id, session.joinCodeHash, code)) {
    await recordAuditLogBestEffort({
      actorType: "SYSTEM",
      action: "CUSTOMER_JOIN_FAILED",
      targetType: "TableSession",
      targetId: session.id,
      metadata: { tableNumber: table.number },
    });
    res.status(401).json({ error: "입장 코드가 올바르지 않아요. 직원에게 코드를 다시 확인해 주세요." });
    return;
  }

  const { rawToken } = await issueDeviceSession(session.id);

  res.cookie(CUSTOMER_SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: CUSTOMER_SESSION_TTL_MS,
    path: "/",
  });

  await recordAuditLogBestEffort({
    actorType: "SYSTEM",
    action: "CUSTOMER_JOINED",
    targetType: "TableSession",
    targetId: session.id,
    metadata: { tableNumber: table.number },
  });

  res.json({ open: true, joined: true, tableNumber: table.number });
});

/**
 * 손님 메뉴. FRONT 전용 상품(룰렛/보드게임/닌텐도 등)과 논리 삭제된 메뉴·옵션은 여기 나오지 않는다.
 * 목록에서 감추는 것만으로는 부족하므로, ID를 직접 보내는 주문도 order.ts의 채널 검증이 거부한다
 * (요구사항.md §4 — 손님이 ID로 직접 주문해도 거부).
 */
customerRouter.get("/menu", requireTableSession, async (_req, res) => {
  const categories = await listSellableMenu("TABLE");
  res.json({ categories });
});

customerRouter.get("/session", requireTableSession, async (req, res) => {
  const bill = await computeBill(req.tableSession!.id);
  res.json({
    tableNumber: req.tableSession!.tableNumber,
    sessionStatus: req.tableSession!.sessionStatus,
    bill,
  });
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

// 직원 호출 (요구사항.md §2.1, §19 "직원 호출") — 이미 대기 중인 호출이 있으면 중복 생성하지 않는다.
customerRouter.get("/staff-call", requireTableSession, async (req, res) => {
  const pending = await prisma.staffCallRequest.findFirst({
    where: { tableSessionId: req.tableSession!.id, status: { in: ["PENDING", "ACKED"] } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ call: pending });
});

customerRouter.post("/staff-call", requireTableSession, async (req, res) => {
  const tableSessionId = req.tableSession!.id;

  // "조회 후 생성" 사이에 손님이 두 번 누르면 호출이 두 건 생길 수 있다. 트랜잭션 안에서
  // 다시 확인해 세션당 미처리 호출이 항상 최대 1건이 되게 한다(요구사항2.md §3.6).
  const { call, created } = await prisma.$transaction(async (tx) => {
    const existing = await tx.staffCallRequest.findFirst({
      where: { tableSessionId, status: { in: ["PENDING", "ACKED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { call: existing, created: false };
    return { call: await tx.staffCallRequest.create({ data: { tableSessionId } }), created: true };
  });

  if (!created) {
    res.status(200).json({ call });
    return;
  }

  await recordAuditLogBestEffort({
    actorType: "SYSTEM",
    action: "STAFF_CALL_REQUESTED",
    targetType: "StaffCallRequest",
    targetId: call.id,
    metadata: { tableSessionId: req.tableSession!.id },
  });
  appEvents.emit(RealtimeEvent.StaffCallRequested, {
    tableSessionId: req.tableSession!.id,
    tableNumber: req.tableSession!.tableNumber,
    callId: call.id,
  });
  res.status(201).json({ call });
});

customerRouter.post("/orders", requireTableSession, requireOrderableSession, async (req, res) => {
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
