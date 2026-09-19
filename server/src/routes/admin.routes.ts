import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { staffGate, requireStepUp } from "../middleware/requireRole.js";
import { hashPassword } from "../auth/password.js";
import { validatePasswordPolicy } from "../env.js";
import { generateToken } from "../services/tableToken.js";
import { recordAuditLog, verifyAuditLogChain, purgeAuditLogs } from "../services/auditLog.js";
import { getSettings, updateSettings } from "../services/settings.js";
import { computeRevenueSummary } from "../services/reporting.js";
import { createBackup, listBackups, getBackupFilePath } from "../services/backup.js";
import { toCsv } from "../services/csv.js";
import {
  adminResetPassword,
  updateStaffUser,
  bumpAuthVersion,
  StaffAccountError,
} from "../services/staffAccount.js";
import {
  closeTable,
  setTableEnabled,
  evaluateCloseBlockers,
  TableSessionError,
} from "../services/tableSession.js";
import {
  computeClosingPreview,
  createClosingSettlement,
  ClosingError,
} from "../services/closing.js";

export const adminRouter = Router();
adminRouter.use(staffGate("ADMIN"));

/** StaffAccountError / TableSessionError / ClosingError를 공통 응답으로 변환한다. */
function sendDomainError(res: import("express").Response, err: unknown): boolean {
  if (err instanceof StaffAccountError || err instanceof TableSessionError || err instanceof ClosingError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

function parseDateQueryParam(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// ---------- 사용자 관리 ----------

adminRouter.get("/users", async (_req, res) => {
  const users = await prisma.staffUser.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isActive: true,
      mustResetPassword: true,
      mfaEnabled: true,
      isBootstrap: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });
  res.json({ users });
});

const createUserSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(1).max(200),
  displayName: z.string().min(1).max(100),
  role: z.enum(["ADMIN", "FRONT", "POS", "SERVING"]),
});

// 개인별 계정 생성(요구사항2.md §9.2). 길이/기본값 정책은 환경별 기준을 그대로 따른다.
adminRouter.post("/users", async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const policyProblem = validatePasswordPolicy(parsed.data.password, { username: parsed.data.username });
  if (policyProblem) {
    res.status(400).json({ error: policyProblem });
    return;
  }
  const exists = await prisma.staffUser.findUnique({ where: { username: parsed.data.username } });
  if (exists) {
    res.status(409).json({ error: "이미 존재하는 아이디입니다." });
    return;
  }
  const user = await prisma.staffUser.create({
    data: {
      username: parsed.data.username,
      passwordHash: await hashPassword(parsed.data.password),
      displayName: parsed.data.displayName,
      role: parsed.data.role,
    },
  });
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.staff!.id,
    action: "USER_CREATED",
    targetType: "StaffUser",
    targetId: user.id,
    metadata: { username: user.username, role: user.role },
  });
  res.status(201).json({ id: user.id });
});

const updateUserSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  role: z.enum(["ADMIN", "FRONT", "POS", "SERVING"]).optional(),
  isActive: z.boolean().optional(),
});

/**
 * 사용자 정보 수정. role 변경/비활성화는 고위험 작업이므로 step-up 재인증을 요구하고
 * (요구사항2.md §2.5.2), 실제 authVersion 증가·세션 무효화·감사 로그는 staffAccount 서비스가 담당한다.
 */
adminRouter.patch("/users/:id", requireStepUp, async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const updated = await updateStaffUser({
      targetUserId: req.params.id,
      actorId: req.staff!.id,
      ...parsed.data,
    });
    res.json({ id: updated.id });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

const resetPasswordSchema = z.object({ newPassword: z.string().min(1).max(200) });

adminRouter.post("/users/:id/reset-password", requireStepUp, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "새 비밀번호를 입력해 주세요." });
    return;
  }
  try {
    await adminResetPassword({
      targetUserId: req.params.id,
      newPassword: parsed.data.newPassword,
      actorId: req.staff!.id,
    });
    res.json({ ok: true });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

/**
 * 대상 계정의 TOTP MFA 해제(요구사항2.md §2.5.2 "TOTP disable/reset").
 * 인증 앱을 잃어버린 관리자를 복구하는 유일한 경로이므로 step-up이 반드시 필요하다.
 */
adminRouter.post("/users/:id/disable-mfa", requireStepUp, async (req, res) => {
  const target = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
  if (!target) {
    res.status(404).json({ error: "존재하지 않는 사용자입니다." });
    return;
  }
  await prisma.staffUser.update({
    where: { id: target.id },
    data: { mfaEnabled: false, mfaSecretEncrypted: null },
  });
  // 기존 세션을 전부 끊어, 해제 사실을 모르는 세션이 계속 살아있지 않게 한다.
  await bumpAuthVersion(target.id);
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.staff!.id,
    action: "USER_MFA_DISABLED",
    targetType: "StaffUser",
    targetId: target.id,
  });
  res.json({ ok: true });
});

// ---------- 테이블 관리 ----------

adminRouter.get("/tables", async (_req, res) => {
  const tables = await prisma.table.findMany({ orderBy: { sortOrder: "asc" } });
  res.json({ tables });
});

const createTableSchema = z.object({
  number: z.number().int().min(1),
  name: z.string().max(50).optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.post("/tables", async (req, res) => {
  const parsed = createTableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const table = await prisma.table.create({
    data: { ...parsed.data, publicSlug: generateToken(16) },
  });
  res.status(201).json({ table });
});

/**
 * 요구사항2.md §3.2 — status를 직접 세팅하는 경로를 스키마에서 제거했다.
 * OPEN/SETTLING/AVAILABLE 전이는 오직 상태 머신(openTable / closeTable / 자동 정산)만 수행하고,
 * 활성/비활성은 아래 전용 엔드포인트로만 바꾼다.
 */
const updateTableSchema = z.object({
  name: z.string().max(50).optional(),
  sortOrder: z.number().int().optional(),
  ordersLocked: z.boolean().optional(),
  paymentsLocked: z.boolean().optional(),
});

adminRouter.patch("/tables/:id", async (req, res) => {
  const parsed = updateTableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const before = await prisma.table.findUnique({ where: { id: req.params.id } });
  if (!before) {
    res.status(404).json({ error: "존재하지 않는 테이블입니다." });
    return;
  }
  const table = await prisma.table.update({ where: { id: req.params.id }, data: parsed.data });

  if (parsed.data.ordersLocked !== undefined && parsed.data.ordersLocked !== before.ordersLocked) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "TABLE_ORDERS_LOCK_CHANGED",
      targetType: "Table",
      targetId: table.id,
      metadata: { ordersLocked: parsed.data.ordersLocked },
    });
  }
  if (parsed.data.paymentsLocked !== undefined && parsed.data.paymentsLocked !== before.paymentsLocked) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "TABLE_PAYMENTS_LOCK_CHANGED",
      targetType: "Table",
      targetId: table.id,
      metadata: { paymentsLocked: parsed.data.paymentsLocked },
    });
  }
  res.json({ table });
});

const setEnabledSchema = z.object({ enabled: z.boolean() });

/** 테이블 사용 중지/재개. 사용 중(ACTIVE 세션)인 테이블은 중지할 수 없다. */
adminRouter.post("/tables/:id/enabled", async (req, res) => {
  const parsed = setEnabledSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const table = await setTableEnabled({
      tableId: req.params.id,
      enabled: parsed.data.enabled,
      staffId: req.staff!.id,
    });
    res.json({ table });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

/** 강제 종료 전에 "무엇을 남긴 채 닫는 것인지"를 운영자에게 먼저 보여준다. */
adminRouter.get("/tables/:id/force-close-preview", async (req, res) => {
  const session = await prisma.tableSession.findFirst({
    where: { tableId: req.params.id, status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } },
    orderBy: { openedAt: "desc" },
  });
  if (!session) {
    res.status(404).json({ error: "진행 중인 테이블 세션이 없어요." });
    return;
  }
  const blockers = await evaluateCloseBlockers(session.id);
  res.json({ tableSessionId: session.id, blockers });
});

const forceCloseSchema = z.object({ reason: z.string().min(1).max(200) });

/**
 * ADMIN 강제 종료(요구사항2.md §3.1). FRONT의 일반 종료와 분리된 별도 경로이며
 * ADMIN 권한 + step-up 재인증 + 사유를 모두 요구한다. 남은 금액/미서빙 주문 현황은
 * closeTable이 감사 로그 metadata에 통째로 기록한다 — 삭제가 아니라 "기록이 남는 종료"다.
 */
adminRouter.post("/tables/:id/force-close", requireStepUp, async (req, res) => {
  const parsed = forceCloseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "강제 종료 사유를 입력해 주세요." });
    return;
  }
  try {
    const session = await closeTable({
      tableId: req.params.id,
      closedById: req.staff!.id,
      reason: parsed.data.reason,
      force: true,
    });
    res.json({ session });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

adminRouter.post("/tables/:id/rotate-slug", async (req, res) => {
  const table = await prisma.table.update({
    where: { id: req.params.id },
    data: { publicSlug: generateToken(16) },
  });
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.staff!.id,
    action: "TABLE_TOKEN_ROTATED",
    targetType: "Table",
    targetId: table.id,
  });
  res.json({ table });
});

// ---------- 메뉴 관리 ----------

adminRouter.get("/menu/categories", async (_req, res) => {
  const categories = await prisma.menuCategory.findMany({
    orderBy: { sortOrder: "asc" },
    include: { items: { include: { optionGroups: { include: { choices: true } } } } },
  });
  res.json({ categories });
});

const createCategorySchema = z.object({ name: z.string().min(1).max(50), sortOrder: z.number().int().optional() });

adminRouter.post("/menu/categories", async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const category = await prisma.menuCategory.create({ data: parsed.data });
  res.status(201).json({ category });
});

const createItemSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  price: z.number().int().min(0),
  imageUrl: z.string().url().max(500).optional(),
  needsCooking: z.boolean().optional(),
  showInKitchen: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.post("/menu/items", async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const item = await prisma.menuItem.create({ data: parsed.data });
  res.status(201).json({ item });
});

const updateItemSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  price: z.number().int().min(0).optional(),
  imageUrl: z.string().url().max(500).optional(),
  isActive: z.boolean().optional(),
  isSoldOut: z.boolean().optional(),
  needsCooking: z.boolean().optional(),
  showInKitchen: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.patch("/menu/items/:id", async (req, res) => {
  const parsed = updateItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const before = await prisma.menuItem.findUnique({ where: { id: req.params.id } });
  if (!before) {
    res.status(404).json({ error: "존재하지 않는 메뉴입니다." });
    return;
  }
  const item = await prisma.menuItem.update({ where: { id: req.params.id }, data: parsed.data });

  if (parsed.data.price !== undefined && parsed.data.price !== before.price) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "MENU_PRICE_CHANGED",
      targetType: "MenuItem",
      targetId: item.id,
      metadata: { from: before.price, to: parsed.data.price },
    });
  }
  if (parsed.data.isSoldOut !== undefined && parsed.data.isSoldOut !== before.isSoldOut) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "MENU_SOLD_OUT",
      targetType: "MenuItem",
      targetId: item.id,
      metadata: { isSoldOut: parsed.data.isSoldOut },
    });
  }
  res.json({ item });
});

const createOptionGroupSchema = z.object({
  name: z.string().min(1).max(50),
  required: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
});

adminRouter.post("/menu/items/:id/option-groups", async (req, res) => {
  const parsed = createOptionGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const group = await prisma.optionGroup.create({ data: { menuItemId: req.params.id, ...parsed.data } });
  res.status(201).json({ group });
});

// 의도적인 마이너스 가격 옵션 기능은 없다 — 음수 추가금은 곧 우회 할인이 되므로 막는다(요구사항2.md §3.3).
const createOptionChoiceSchema = z.object({
  name: z.string().min(1).max(50),
  extraPrice: z.number().int().min(0).default(0),
});

adminRouter.post("/menu/option-groups/:id/choices", async (req, res) => {
  const parsed = createOptionChoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const choice = await prisma.optionChoice.create({ data: { groupId: req.params.id, ...parsed.data } });
  res.status(201).json({ choice });
});

// ---------- 보드게임 이용권 관리 ----------

adminRouter.get("/game-plans", async (_req, res) => {
  const plans = await prisma.gameTimePlan.findMany({ orderBy: { minutes: "asc" } });
  res.json({ plans });
});

const createPlanSchema = z.object({ name: z.string().min(1).max(50), minutes: z.number().int().min(1), price: z.number().int().min(0) });

adminRouter.post("/game-plans", async (req, res) => {
  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const plan = await prisma.gameTimePlan.create({ data: parsed.data });
  res.status(201).json({ plan });
});

const updatePlanSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  minutes: z.number().int().min(1).optional(),
  price: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.patch("/game-plans/:id", async (req, res) => {
  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const plan = await prisma.gameTimePlan.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ plan });
});

// ---------- 결제수단 관리 ----------

adminRouter.get("/payment-methods", async (_req, res) => {
  const methods = await prisma.paymentMethod.findMany({ orderBy: { sortOrder: "asc" } });
  res.json({ methods });
});

const createPaymentMethodSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(30)
    .regex(/^[A-Z0-9_]+$/, "영문 대문자/숫자/밑줄만 사용할 수 있어요."),
  name: z.string().min(1).max(30),
  sortOrder: z.number().int().optional(),
});

adminRouter.post("/payment-methods", async (req, res) => {
  const parsed = createPaymentMethodSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "결제수단 코드는 영문 대문자/숫자/밑줄만 사용할 수 있어요." });
    return;
  }
  const exists = await prisma.paymentMethod.findUnique({ where: { code: parsed.data.code } });
  if (exists) {
    res.status(409).json({ error: "이미 존재하는 결제수단 코드예요." });
    return;
  }
  // 커스텀 결제수단은 항상 isCash=false — 실물 현금 거스름돈 계산은 기본 CASH에서만 지원한다.
  const method = await prisma.paymentMethod.create({ data: { ...parsed.data, isCash: false } });
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.staff!.id,
    action: "PAYMENT_METHOD_CREATED",
    targetType: "PaymentMethod",
    targetId: method.id,
    metadata: { code: method.code, name: method.name },
  });
  res.status(201).json({ method });
});

const updatePaymentMethodSchema = z.object({
  name: z.string().min(1).max(30).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.patch("/payment-methods/:id", async (req, res) => {
  const parsed = updatePaymentMethodSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const target = await prisma.paymentMethod.findUnique({ where: { id: req.params.id } });
  if (!target) {
    res.status(404).json({ error: "존재하지 않는 결제수단이에요." });
    return;
  }
  if (target.code === "CASH" && parsed.data.isActive === false) {
    res.status(400).json({ error: "현금 결제수단은 비활성화할 수 없어요." });
    return;
  }
  const method = await prisma.paymentMethod.update({ where: { id: target.id }, data: parsed.data });
  res.json({ method });
});

// ---------- 결제 내역 ----------

const paymentSearchSchema = z.object({
  tableNumber: z.coerce.number().int().optional(),
  kind: z.enum(["CHARGE", "DISCOUNT", "VOID", "REFUND"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

adminRouter.get("/payments", async (req, res) => {
  const parsed = paymentSearchSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "검색 조건이 올바르지 않아요." });
    return;
  }
  const where: NonNullable<Parameters<typeof prisma.payment.findMany>[0]>["where"] = {};
  if (parsed.data.kind) where.kind = parsed.data.kind;
  if (parsed.data.tableNumber) {
    where.tableSession = { table: { number: parsed.data.tableNumber } };
  }
  const payments = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit ?? 100,
    include: {
      allocations: true,
      createdBy: { select: { displayName: true } },
      tableSession: { include: { table: { select: { number: true } } } },
    },
  });
  res.json({ payments });
});

// ---------- 매출 현황 ----------

adminRouter.get("/revenue", async (req, res) => {
  const since = parseDateQueryParam(req.query.since);
  const until = parseDateQueryParam(req.query.until);
  const summary = await computeRevenueSummary(since, until);
  res.json({ summary });
});

// ---------- 운영 설정 ----------

adminRouter.get("/settings", async (_req, res) => {
  const settings = await getSettings();
  res.json({ settings });
});

const updateSettingsSchema = z.object({
  orderingEnabled: z.boolean().optional(),
  paymentsEnabled: z.boolean().optional(),
  kdsWarnAfterSeconds: z.number().int().min(30).max(3600).optional(),
  kdsDangerAfterSeconds: z.number().int().min(30).max(7200).optional(),
  servedRevertWindowSeconds: z.number().int().min(0).max(3600).optional(),
});

adminRouter.patch("/settings", async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  if (
    parsed.data.kdsWarnAfterSeconds !== undefined &&
    parsed.data.kdsDangerAfterSeconds !== undefined &&
    parsed.data.kdsWarnAfterSeconds >= parsed.data.kdsDangerAfterSeconds
  ) {
    res.status(400).json({ error: "지연 기준 시간은 임박 기준 시간보다 커야 해요." });
    return;
  }
  const settings = await updateSettings(parsed.data, req.staff!.id);
  res.json({ settings });
});

// ---------- 감사 로그 ----------

const auditLogQuerySchema = z.object({
  action: z.string().optional(),
  actorId: z.string().optional(),
  targetId: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function buildAuditLogWhere(query: z.infer<typeof auditLogQuerySchema>) {
  const where: NonNullable<Parameters<typeof prisma.auditLog.findMany>[0]>["where"] = {};
  if (query.action) where.action = query.action;
  if (query.actorId) where.actorId = query.actorId;
  if (query.targetId) where.targetId = query.targetId;
  const since = query.since ? new Date(query.since) : undefined;
  const until = query.until ? new Date(query.until) : undefined;
  if ((since && !Number.isNaN(since.getTime())) || (until && !Number.isNaN(until.getTime()))) {
    where.createdAt = {
      ...(since && !Number.isNaN(since.getTime()) ? { gte: since } : {}),
      ...(until && !Number.isNaN(until.getTime()) ? { lte: until } : {}),
    };
  }
  return where;
}

adminRouter.get("/audit-logs", async (req, res) => {
  const parsed = auditLogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "검색 조건이 올바르지 않아요." });
    return;
  }
  const logs = await prisma.auditLog.findMany({
    where: buildAuditLogWhere(parsed.data),
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit ?? 100,
  });
  res.json({ logs });
});

adminRouter.get("/audit-logs/verify", async (_req, res) => {
  const brokenAt = await verifyAuditLogChain();
  res.json({ ok: brokenAt === null, brokenAt });
});

const purgeAuditLogsSchema = z.object({
  beforeDate: z.string().min(1),
  confirm: z.literal(true),
});

// 요구사항.md §13.5 "로그 삭제" — 이중 확인은 클라이언트가 확인 대화상자로 처리하고,
// 서버는 confirm:true를 명시적으로 요구해 실수로 인한 대량 삭제를 최소화한다.
adminRouter.post("/audit-logs/purge", requireStepUp, async (req, res) => {
  const parsed = purgeAuditLogsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "삭제 기준 날짜와 확인이 필요해요." });
    return;
  }
  const beforeDate = new Date(parsed.data.beforeDate);
  if (Number.isNaN(beforeDate.getTime())) {
    res.status(400).json({ error: "날짜 형식이 올바르지 않아요." });
    return;
  }
  const result = await purgeAuditLogs(beforeDate, req.staff!.id);
  res.json({ result });
});

adminRouter.get("/export/audit-logs.csv", async (req, res) => {
  const parsed = auditLogQuerySchema.safeParse(req.query);
  const logs = await prisma.auditLog.findMany({
    where: parsed.success ? buildAuditLogWhere(parsed.data) : undefined,
    orderBy: { createdAt: "asc" },
  });
  const csv = toCsv(
    ["시각", "행위자유형", "행위자ID", "액션", "대상유형", "대상ID", "메타데이터"],
    logs.map((l) => [l.createdAt.toISOString(), l.actorType, l.actorId, l.action, l.targetType, l.targetId, l.metadata]),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-logs.csv"`);
  res.send(csv);
});

// ---------- 매출 CSV 내보내기 ----------

adminRouter.get("/export/revenue.csv", async (req, res) => {
  const since = parseDateQueryParam(req.query.since);
  const until = parseDateQueryParam(req.query.until);
  const summary = await computeRevenueSummary(since, until);

  const rows: (string | number)[][] = [
    ["총매출", summary.totalRevenue],
    ["총할인", summary.totalDiscount],
    ["취소 주문 수", summary.cancelledOrderCount],
    ["거부 주문 수", summary.rejectedOrderCount],
    [],
    ["결제수단", "매출"],
    ...summary.byMethod.map((m) => [m.method, m.amount]),
    [],
    ["메뉴", "판매수량", "매출"],
    ...summary.menuSales.map((m) => [m.name, m.quantitySold, m.revenue]),
    [],
    ["테이블 번호", "매출"],
    ...summary.byTable.map((t) => [t.tableNumber, t.revenue]),
  ];

  const csv = toCsv(["항목", "값1", "값2"], rows.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? ""]));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="revenue.csv"`);
  res.send(csv);
});

// ---------- DB 백업 ----------

adminRouter.get("/backups", async (_req, res) => {
  // listBackups는 체크섬 계산 때문에 비동기다 — await하지 않으면 Promise가 그대로 직렬화된다.
  res.json({ backups: await listBackups() });
});

adminRouter.post("/backups", requireStepUp, async (req, res) => {
  try {
    const backup = await createBackup(req.staff!.id);
    res.status(201).json({ backup });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "백업 중 오류가 발생했어요." });
  }
});

adminRouter.get("/backups/:filename", requireStepUp, async (req, res) => {
  const filePath = getBackupFilePath(req.params.filename);
  if (!filePath) {
    res.status(404).json({ error: "존재하지 않는 백업 파일이에요." });
    return;
  }
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.staff!.id,
    action: "DB_BACKUP_DOWNLOADED",
    metadata: { filename: req.params.filename },
  });
  res.download(filePath, req.params.filename);
});

// ---------- 영업 마감 / 정산 (요구사항2.md §9.1) ----------

adminRouter.get("/closing/preview", async (req, res) => {
  const since = parseDateQueryParam(req.query.since);
  const until = parseDateQueryParam(req.query.until);
  const preview = await computeClosingPreview(since, until);
  res.json({ preview });
});

adminRouter.get("/closing/history", async (_req, res) => {
  const settlements = await prisma.closingSettlement.findMany({
    orderBy: { closedAt: "desc" },
    take: 50,
    include: { closedBy: { select: { displayName: true } } },
  });
  res.json({ settlements });
});

const createClosingSchema = z.object({
  actualCash: z.number().int().min(0),
  note: z.string().max(500).optional(),
  overrideReason: z.string().max(200).optional(),
});

/**
 * 마감 확정. 금전 원장을 확정하는 작업이므로 step-up을 요구한다.
 * 미정산 테이블이 남았는데도 강행하려면 overrideReason이 필수다(서비스에서 검증).
 */
adminRouter.post("/closing", requireStepUp, async (req, res) => {
  const parsed = createClosingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "실제 현금 금액을 확인해 주세요." });
    return;
  }
  try {
    const settlement = await createClosingSettlement({
      actualCash: parsed.data.actualCash,
      note: parsed.data.note,
      overrideReason: parsed.data.overrideReason,
      closedById: req.staff!.id,
    });
    res.status(201).json({ settlement });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

adminRouter.get("/export/closing.csv", async (req, res) => {
  const since = parseDateQueryParam(req.query.since);
  const until = parseDateQueryParam(req.query.until);
  const preview = await computeClosingPreview(since, until);

  const rows: (string | number)[][] = [
    ["집계 시작", preview.openedAt.toISOString()],
    ["집계 종료", preview.closedAt.toISOString()],
    ["총 주문 금액", preview.totalOrderAmount],
    ["실제 매출", preview.totalRevenue],
    ["총 할인", preview.totalDiscount],
    ["VOID 합계", preview.totalVoid],
    ["REFUND 합계", preview.totalRefund],
    ["현금 예상액", preview.expectedCash],
    ["취소 주문 수", preview.cancelledOrderCount],
    ["거부 주문 수", preview.rejectedOrderCount],
    [],
    ["결제수단", "매출"],
    ...preview.byMethod.map((m) => [m.method, m.amount]),
    [],
    ["미정산 테이블", "상태", "남은 금액"],
    ...preview.unsettledTables.map((t) => [t.tableNumber, t.status, t.remainingAmount]),
    [],
    ["강제 종료 테이블", "종료 시각", "사유"],
    ...preview.forceClosedSessions.map((s) => [s.tableNumber, s.closedAt?.toISOString() ?? "", s.reason ?? ""]),
  ];

  const csv = toCsv(["항목", "값1", "값2"], rows.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? ""]));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="closing.csv"');
  res.send(csv);
});
