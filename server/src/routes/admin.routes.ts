import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireRole } from "../middleware/requireRole.js";
import { hashPassword } from "../auth/password.js";
import { generateToken } from "../services/tableToken.js";
import { recordAuditLog, verifyAuditLogChain, purgeAuditLogs } from "../services/auditLog.js";
import { getSettings, updateSettings } from "../services/settings.js";
import { computeRevenueSummary } from "../services/reporting.js";
import { createBackup, listBackups, getBackupFilePath } from "../services/backup.js";
import { toCsv } from "../services/csv.js";

export const adminRouter = Router();
adminRouter.use(requireRole("ADMIN"));

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
      isBootstrap: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });
  res.json({ users });
});

const createUserSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(100),
  role: z.enum(["ADMIN", "FRONT", "POS", "SERVING"]),
});

adminRouter.post("/users", async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
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
    actorId: req.session.staffUserId,
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

adminRouter.patch("/users/:id", async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const target = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
  if (!target) {
    res.status(404).json({ error: "존재하지 않는 사용자입니다." });
    return;
  }
  const updated = await prisma.staffUser.update({ where: { id: target.id }, data: parsed.data });

  if (parsed.data.role && parsed.data.role !== target.role) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.session.staffUserId,
      action: "USER_ROLE_CHANGED",
      targetType: "StaffUser",
      targetId: target.id,
      metadata: { from: target.role, to: parsed.data.role },
    });
  }
  if (parsed.data.isActive === false && target.isActive) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.session.staffUserId,
      action: "USER_DISABLED",
      targetType: "StaffUser",
      targetId: target.id,
    });
  }
  res.json({ id: updated.id });
});

const resetPasswordSchema = z.object({ newPassword: z.string().min(8).max(200) });

adminRouter.post("/users/:id/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "비밀번호는 8자 이상이어야 합니다." });
    return;
  }
  const target = await prisma.staffUser.findUnique({ where: { id: req.params.id } });
  if (!target) {
    res.status(404).json({ error: "존재하지 않는 사용자입니다." });
    return;
  }
  await prisma.staffUser.update({
    where: { id: target.id },
    data: { passwordHash: await hashPassword(parsed.data.newPassword), mustResetPassword: true },
  });
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.session.staffUserId,
    action: "USER_PASSWORD_RESET",
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

const updateTableSchema = z.object({
  name: z.string().max(50).optional(),
  status: z.enum(["DISABLED", "AVAILABLE", "OPEN", "SETTLING"]).optional(),
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
  if (parsed.data.status === "DISABLED") {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.session.staffUserId,
      action: "TABLE_DISABLED",
      targetType: "Table",
      targetId: table.id,
    });
  }
  if (parsed.data.ordersLocked !== undefined && parsed.data.ordersLocked !== before.ordersLocked) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.session.staffUserId,
      action: "TABLE_ORDERS_LOCK_CHANGED",
      targetType: "Table",
      targetId: table.id,
      metadata: { ordersLocked: parsed.data.ordersLocked },
    });
  }
  if (parsed.data.paymentsLocked !== undefined && parsed.data.paymentsLocked !== before.paymentsLocked) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.session.staffUserId,
      action: "TABLE_PAYMENTS_LOCK_CHANGED",
      targetType: "Table",
      targetId: table.id,
      metadata: { paymentsLocked: parsed.data.paymentsLocked },
    });
  }
  res.json({ table });
});

adminRouter.post("/tables/:id/rotate-slug", async (req, res) => {
  const table = await prisma.table.update({
    where: { id: req.params.id },
    data: { publicSlug: generateToken(16) },
  });
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.session.staffUserId,
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
      actorId: req.session.staffUserId,
      action: "MENU_PRICE_CHANGED",
      targetType: "MenuItem",
      targetId: item.id,
      metadata: { from: before.price, to: parsed.data.price },
    });
  }
  if (parsed.data.isSoldOut !== undefined && parsed.data.isSoldOut !== before.isSoldOut) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.session.staffUserId,
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

const createOptionChoiceSchema = z.object({ name: z.string().min(1).max(50), extraPrice: z.number().int().default(0) });

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
    actorId: req.session.staffUserId,
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
  const sinceParam = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
  const since = sinceParam && !Number.isNaN(sinceParam.getTime()) ? sinceParam : undefined;
  const summary = await computeRevenueSummary(since);
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
  const settings = await updateSettings(parsed.data, req.session.staffUserId!);
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
adminRouter.post("/audit-logs/purge", async (req, res) => {
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
  const result = await purgeAuditLogs(beforeDate, req.session.staffUserId!);
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
  const sinceParam = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
  const since = sinceParam && !Number.isNaN(sinceParam.getTime()) ? sinceParam : undefined;
  const summary = await computeRevenueSummary(since);

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
  res.json({ backups: listBackups() });
});

adminRouter.post("/backups", async (req, res) => {
  try {
    const backup = await createBackup(req.session.staffUserId);
    res.status(201).json({ backup });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "백업 중 오류가 발생했어요." });
  }
});

adminRouter.get("/backups/:filename", async (req, res) => {
  const filePath = getBackupFilePath(req.params.filename);
  if (!filePath) {
    res.status(404).json({ error: "존재하지 않는 백업 파일이에요." });
    return;
  }
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.session.staffUserId,
    action: "DB_BACKUP_DOWNLOADED",
    metadata: { filename: req.params.filename },
  });
  res.download(filePath, req.params.filename);
});
