import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireRole } from "../middleware/requireRole.js";
import { hashPassword } from "../auth/password.js";
import { generateToken } from "../services/tableToken.js";
import { recordAuditLog, verifyAuditLogChain } from "../services/auditLog.js";

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
});

adminRouter.patch("/tables/:id", async (req, res) => {
  const parsed = updateTableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
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

// ---------- 감사 로그 ----------

adminRouter.get("/audit-logs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const action = typeof req.query.action === "string" ? req.query.action : undefined;
  const logs = await prisma.auditLog.findMany({
    where: action ? { action } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json({ logs });
});

adminRouter.get("/audit-logs/verify", async (_req, res) => {
  const brokenAt = await verifyAuditLogChain();
  res.json({ ok: brokenAt === null, brokenAt });
});
