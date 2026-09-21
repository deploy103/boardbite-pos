import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { staffGate, requireStepUp, isElevated } from "../middleware/requireRole.js";
import { hashPassword } from "../auth/password.js";
import { validatePasswordPolicy } from "../env.js";
import { generateToken } from "../services/tableToken.js";
import { recordAuditLog, verifyAuditLogChain, purgeAuditLogs } from "../services/auditLog.js";
import { getSettings, updateSettings } from "../services/settings.js";
import { computeRevenueSummary } from "../services/reporting.js";
import { createBackup, listBackups, getBackupFilePath } from "../services/backup.js";
import { excelText, toCsv } from "../services/csv.js";
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
import {
  MenuCatalogError,
  assertCookingFlags,
  deleteMenuCategory,
  deleteMenuItem,
  deleteOptionChoice,
  deleteOptionGroup,
  listMenuForAdmin,
  updateMenuItem,
  updateOptionChoice,
  updateOptionGroup,
} from "../services/menuCatalog.js";
import {
  COUPON_STATE_LABEL,
  CouponError,
  MAX_COUPON_NUMBER,
  cancelCoupons,
  couponNumberAvailability,
  issueCouponBatch,
  listCouponBatches,
  listCoupons,
  unusedItemCouponsForMenuItem,
  type CouponState,
} from "../services/coupon.js";
import {
  CounterSaleError,
  cancelCounterSale,
  getCounterSaleDetail,
  listCounterSales,
} from "../services/counterSale.js";

export const adminRouter = Router();
adminRouter.use(staffGate("ADMIN"));

/** StaffAccountError / TableSessionError / ClosingError를 공통 응답으로 변환한다. */
function sendDomainError(res: import("express").Response, err: unknown): boolean {
  if (err instanceof StaffAccountError || err instanceof TableSessionError || err instanceof ClosingError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  if (err instanceof MenuCatalogError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  if (err instanceof CouponError || err instanceof CounterSaleError) {
    res.status(err.status).json({ error: err.message, code: err.code });
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

/**
 * 직원 계정 생성(요구사항2.md §9.2). 시드는 ADMIN 하나만 만들므로 FRONT/POS/SERVING 계정은
 * 전부 이 경로로만 생긴다 — 라우터 전체가 staffGate("ADMIN") 뒤에 있으므로 관리자 화면에서만 가능하다.
 *
 * 비밀번호 최소 길이는 만들려는 역할이 결정한다(ADMIN 15자 / 그 외 10자).
 * ADMIN 계정 생성은 권한 상승에 해당하므로 step-up 재인증까지 통과해야 한다
 * (role 변경/비밀번호 초기화와 같은 등급의 작업이다).
 */
adminRouter.post("/users", async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  if (parsed.data.role === "ADMIN" && !isElevated(req)) {
    res.status(403).json({
      error: "관리자 계정을 만들려면 보안을 위해 비밀번호를 다시 확인해 주세요.",
      code: "STEP_UP_REQUIRED",
    });
    return;
  }
  const policyProblem = validatePasswordPolicy(parsed.data.password, {
    username: parsed.data.username,
    role: parsed.data.role,
  });
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

// ---------- 메뉴 관리 (요구사항.md §3.1, §4) ----------

adminRouter.get("/menu/categories", async (_req, res) => {
  res.json({ categories: await listMenuForAdmin() });
});

const categorySchema = z.object({ name: z.string().min(1).max(50), sortOrder: z.number().int().optional() });

adminRouter.post("/menu/categories", async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const category = await prisma.menuCategory.create({ data: parsed.data });
  res.status(201).json({ category });
});

adminRouter.patch("/menu/categories/:id", async (req, res) => {
  const parsed = categorySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const existing = await prisma.menuCategory.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "존재하지 않는 카테고리예요." });
    return;
  }
  const category = await prisma.menuCategory.update({ where: { id: req.params.id }, data: parsed.data });
  res.json({ category });
});

/**
 * 카테고리 삭제. 소속 메뉴가 남아 있으면 409로 막고 개수를 알려준다 —
 * 연쇄 삭제로 메뉴를 함께 지우지 않는다(요구사항.md §4).
 */
adminRouter.delete("/menu/categories/:id", async (req, res) => {
  try {
    const category = await deleteMenuCategory(req.params.id);
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "MENU_CATEGORY_DELETED",
      targetType: "MenuCategory",
      targetId: category.id,
      metadata: { name: category.name },
    });
    res.json({ category });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

const createItemSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  price: z.number().int().min(0),
  imageUrl: z.string().url().max(500).optional(),
  needsCooking: z.boolean().optional(),
  showInKitchen: z.boolean().optional(),
  channel: z.enum(["TABLE", "FRONT", "BOTH"]).optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.post("/menu/items", async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const category = await prisma.menuCategory.findUnique({ where: { id: parsed.data.categoryId } });
  if (!category || category.deletedAt) {
    res.status(404).json({ error: "존재하지 않는 카테고리예요." });
    return;
  }
  try {
    assertCookingFlags(parsed.data.needsCooking ?? true, parsed.data.showInKitchen ?? true);
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
    return;
  }
  const item = await prisma.menuItem.create({ data: parsed.data });
  res.status(201).json({ item });
});

const updateItemSchema = z.object({
  categoryId: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  price: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  isSoldOut: z.boolean().optional(),
  needsCooking: z.boolean().optional(),
  showInKitchen: z.boolean().optional(),
  channel: z.enum(["TABLE", "FRONT", "BOTH"]).optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.patch("/menu/items/:id", async (req, res) => {
  const parsed = updateItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const { before, item } = await updateMenuItem(req.params.id, parsed.data);

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
    if (parsed.data.categoryId !== undefined && parsed.data.categoryId !== before.categoryId) {
      await recordAuditLog({
        actorType: "STAFF",
        actorId: req.staff!.id,
        action: "MENU_MOVED",
        targetType: "MenuItem",
        targetId: item.id,
        metadata: { from: before.categoryId, to: parsed.data.categoryId },
      });
    }
    res.json({ item });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

/**
 * 삭제 전 영향 확인. 이 메뉴를 대상으로 하는 **미사용 상품권**이 몇 장 남았는지 먼저 보여준다
 * (요구사항.md §6.2 — 메뉴 삭제 전 미사용 상품권 영향을 함께 보여준다).
 */
adminRouter.get("/menu/items/:id/delete-preview", async (req, res) => {
  const item = await prisma.menuItem.findUnique({ where: { id: req.params.id } });
  if (!item || item.deletedAt) {
    res.status(404).json({ error: "존재하지 않는 메뉴예요." });
    return;
  }
  const [orderedCount, coupons] = await Promise.all([
    prisma.orderItem.count({ where: { menuItemId: item.id } }),
    unusedItemCouponsForMenuItem(item.id),
  ]);
  res.json({ item: { id: item.id, name: item.name }, orderedCount, coupons });
});

adminRouter.delete("/menu/items/:id", async (req, res) => {
  try {
    const item = await deleteMenuItem(req.params.id);
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "MENU_ITEM_DELETED",
      targetType: "MenuItem",
      targetId: item.id,
      metadata: { name: item.name, price: item.price },
    });
    res.json({ item });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

// ---- 옵션 그룹 / 선택지 ----

const optionGroupSchema = z.object({
  name: z.string().min(1).max(50),
  required: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

adminRouter.post("/menu/items/:id/option-groups", async (req, res) => {
  const parsed = optionGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const item = await prisma.menuItem.findUnique({ where: { id: req.params.id } });
  if (!item || item.deletedAt) {
    res.status(404).json({ error: "존재하지 않는 메뉴예요." });
    return;
  }
  const group = await prisma.optionGroup.create({ data: { menuItemId: item.id, ...parsed.data } });
  res.status(201).json({ group });
});

adminRouter.patch("/menu/items/:menuItemId/option-groups/:groupId", async (req, res) => {
  const parsed = optionGroupSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const group = await updateOptionGroup(req.params.groupId, req.params.menuItemId, parsed.data);
    res.json({ group });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

adminRouter.delete("/menu/items/:menuItemId/option-groups/:groupId", async (req, res) => {
  try {
    await deleteOptionGroup(req.params.groupId, req.params.menuItemId);
    await recordAuditLog({
      actorType: "STAFF",
      actorId: req.staff!.id,
      action: "MENU_OPTION_GROUP_DELETED",
      targetType: "OptionGroup",
      targetId: req.params.groupId,
      metadata: { menuItemId: req.params.menuItemId },
    });
    res.json({ ok: true });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

// 의도적인 마이너스 가격 옵션 기능은 없다 — 음수 추가금은 곧 우회 할인이 되므로 막는다(요구사항2.md §3.3).
const optionChoiceSchema = z.object({
  name: z.string().min(1).max(50),
  extraPrice: z.number().int().min(0).default(0),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

adminRouter.post("/menu/option-groups/:id/choices", async (req, res) => {
  const parsed = optionChoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  const group = await prisma.optionGroup.findUnique({ where: { id: req.params.id } });
  if (!group || group.deletedAt) {
    res.status(404).json({ error: "존재하지 않는 옵션 그룹이에요." });
    return;
  }
  const choice = await prisma.optionChoice.create({ data: { groupId: group.id, ...parsed.data } });
  res.status(201).json({ choice });
});

adminRouter.patch("/menu/option-groups/:groupId/choices/:choiceId", async (req, res) => {
  const parsed = optionChoiceSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const choice = await updateOptionChoice(req.params.choiceId, req.params.groupId, parsed.data);
    res.json({ choice });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

adminRouter.delete("/menu/option-groups/:groupId/choices/:choiceId", async (req, res) => {
  try {
    await deleteOptionChoice(req.params.choiceId, req.params.groupId);
    res.json({ ok: true });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

// ---------- 쿠폰 (요구사항.md §6.1) ----------

adminRouter.get("/coupons/availability", async (_req, res) => {
  res.json({ availability: await couponNumberAvailability() });
});

adminRouter.get("/coupons/batches", async (_req, res) => {
  res.json({ batches: await listCouponBatches() });
});

const couponListQuerySchema = z.object({
  code: z.string().max(10).optional(),
  type: z.enum(["AMOUNT", "ITEM"]).optional(),
  batchId: z.string().optional(),
  state: z.enum(["AVAILABLE", "USED", "EXPIRED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

adminRouter.get("/coupons", async (req, res) => {
  const parsed = couponListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "검색 조건이 올바르지 않아요." });
    return;
  }
  res.json({ coupons: await listCoupons(parsed.data) });
});

const issueBatchSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(100),
    type: z.enum(["AMOUNT", "ITEM"]),
    name: z.string().min(1).max(100),
    memo: z.string().max(300).optional(),
    amount: z.number().int().positive().optional(),
    targetMenuItemIds: z.array(z.string().min(1)).max(50).optional(),
    quantity: z.number().int().min(1).max(MAX_COUPON_NUMBER),
    expiresAt: z.string().max(40).nullable().optional(),
  })
  .refine((v) => (v.type === "AMOUNT" ? v.amount !== undefined : (v.targetMenuItemIds?.length ?? 0) > 0), {
    message: "금액권은 금액을, 상품권은 대상 메뉴를 지정해야 해요.",
  });

adminRouter.post("/coupons/batches", async (req, res) => {
  const parsed = issueBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "입력값이 올바르지 않습니다." });
    return;
  }
  try {
    const { batch, reused } = await issueCouponBatch({ ...parsed.data, createdById: req.staff!.id });
    if (!reused) {
      await recordAuditLog({
        actorType: "STAFF",
        actorId: req.staff!.id,
        action: "COUPON_BATCH_ISSUED",
        targetType: "CouponBatch",
        targetId: batch.id,
        metadata: { type: batch.type, quantity: batch.issuedCount, amount: batch.amount },
      });
    }
    res.status(reused ? 200 : 201).json({
      batch: {
        id: batch.id,
        type: batch.type,
        name: batch.name,
        amount: batch.amount,
        expiresAt: batch.expiresAt,
        issuedCount: batch.issuedCount,
        targets: batch.targets,
        codes: batch.coupons.map((c) => c.code),
      },
      reused,
    });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

const cancelCouponsSchema = z.object({ couponIds: z.array(z.string().min(1)).min(1).max(1000) });

/** 미사용 쿠폰 발급 취소. 사용 완료 쿠폰은 건드리지 않고 건너뛴 개수를 알려준다. */
adminRouter.post("/coupons/cancel", async (req, res) => {
  const parsed = cancelCouponsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "취소할 쿠폰을 선택해 주세요." });
    return;
  }
  const result = await cancelCoupons(parsed.data.couponIds, req.staff!.id);
  await recordAuditLog({
    actorType: "STAFF",
    actorId: req.staff!.id,
    action: "COUPON_CANCELLED",
    targetType: "Coupon",
    metadata: result,
  });
  res.json({ result });
});

/**
 * 쿠폰 목록 CSV — 두 가지 형식을 제공한다(요구사항.md §6.1의 "안전한 문자열 포맷" + "가져오기 안내").
 *
 *   ?format=excel : 번호를 따옴표 안 탭 접두(`"\t001"`)로 내보낸다. Excel/Sheets가 텍스트로 읽어
 *                   **앞자리 0이 그대로 유지**되고, 저장 후 다시 열어도 깨지지 않는다.
 *                   사람이 바로 열어보는 용도.
 *   기본(생략)    : 번호를 평문 `001`로 내보낸다. 다른 프로그램이 파싱하기 좋은 깨끗한 데이터.
 *
 * 어느 쪽이든 `="001"` 같은 수식 형태는 쓰지 않는다 — 그 자체가 수식이라 수식 주입 방어와 충돌한다.
 * 번호는 서버가 만든 `[0-9]{3}` 값이라 주입 여지가 없고, 관리자가 자유 입력한 이름·메모 열은
 * 두 형식 모두에서 neutralizeFormula가 그대로 중화한다.
 */
adminRouter.get("/export/coupons.csv", async (req, res) => {
  const parsed = couponListQuerySchema.safeParse(req.query);
  const coupons = await listCoupons(parsed.success ? parsed.data : {});
  const forExcel = req.query.format === "excel";
  const csv = toCsv(
    ["번호", "번호(표시용)", "종류", "혜택", "상태", "배치", "발급일시", "만료", "사용 거래", "사용 직원", "사용 시각"],
    coupons.map((c) => [
      forExcel ? excelText(c.code) : c.code,
      // 어느 형식으로 열든 번호를 확실히 읽을 수 있는 보조 열.
      `쿠폰 ${c.code}`,
      c.type === "AMOUNT" ? "금액권" : "상품권",
      c.benefitLabel,
      COUPON_STATE_LABEL[c.state as CouponState],
      c.batchName,
      new Date(c.issuedAt).toISOString(),
      c.expiresAt ? new Date(c.expiresAt).toISOString() : "",
      // 사용처: 현장 거래는 "#001", 테이블 정산은 "3번 테이블".
      c.redemption
        ? c.redemption.usedAt.kind === "COUNTER"
          ? `현장 #${String(c.redemption.usedAt.saleNo).padStart(3, "0")}`
          : `${c.redemption.usedAt.tableNumber ?? "?"}번 테이블`
        : "",
      c.redemption?.redeemedBy ?? "",
      c.redemption ? new Date(c.redemption.redeemedAt).toISOString() : "",
    ]),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="coupons${forExcel ? "-excel" : ""}.csv"`);
  res.send(csv);
});

// ---------- FRONT 현장 거래 (ADMIN 조회 / 전체 취소) ----------

const counterListQuerySchema = z.object({
  saleNo: z.coerce.number().int().positive().optional(),
  status: z.enum(["COMPLETED", "CANCELLED"]).optional(),
  onlyOpen: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

adminRouter.get("/counter-sales", async (req, res) => {
  const parsed = counterListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "검색 조건이 올바르지 않아요." });
    return;
  }
  res.json({ sales: await listCounterSales(parsed.data) });
});

adminRouter.get("/counter-sales/:id", async (req, res) => {
  try {
    res.json({ sale: await getCounterSaleDetail(req.params.id) });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
});

const cancelSaleSchema = z.object({ reason: z.string().min(1).max(200) });

/**
 * 현장 거래 전체 취소/환불(요구사항.md §6.4).
 * ADMIN + step-up + 사유를 요구하고, 원본을 지우지 않고 반대 원장을 추가한다.
 */
adminRouter.post("/counter-sales/:id/cancel", requireStepUp, async (req, res) => {
  const parsed = cancelSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "취소 사유를 입력해 주세요." });
    return;
  }
  try {
    const { sale } = await cancelCounterSale(req.params.id, req.staff!.id, parsed.data.reason);
    res.json({ sale });
  } catch (err) {
    if (!sendDomainError(res, err)) throw err;
  }
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
  /** 테이블 정산 / FRONT 현장 결제를 나눠 보거나 합쳐서 볼 수 있다(요구사항.md §7). */
  source: z.enum(["TABLE", "COUNTER"]).optional(),
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
  if (parsed.data.source === "TABLE") where.counterSaleId = null;
  if (parsed.data.source === "COUNTER") where.tableSessionId = null;
  const payments = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit ?? 100,
    include: {
      allocations: true,
      createdBy: { select: { displayName: true } },
      tableSession: { include: { table: { select: { number: true } } } },
      // 현장 거래 결제는 테이블이 없다 — 주문번호로 출처를 표시한다(테이블 0번으로 뭉개지 않는다).
      counterSale: { select: { id: true, saleNo: true, status: true } },
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

  // 같은 원장을 쓰는 화면(매출현황/마감)과 열 이름을 맞춘다.
  // "주문액"과 "실제 수납"을 분리해, 정가 합계를 매출로 오해하지 않게 한다(요구사항.md §7).
  const rows: (string | number)[][] = [
    ["총 주문액(정가)", summary.totalOrderAmount],
    ["일반 할인", summary.manualDiscount],
    ["쿠폰 할인(무료 제공)", summary.couponDiscount],
    ["총 할인", summary.totalDiscount],
    ["실제 수납(환불 전)", summary.totalCharged],
    ["실제 환불", summary.totalRefunded],
    ["순매출", summary.totalRevenue],
    ["  ├ 테이블 순매출", summary.byChannel.table],
    ["  └ 현장 순매출", summary.byChannel.counter],
    ["메뉴 배분 수납", summary.menuPaidRevenue],
    ["미배분 수납(게임 이용료/금액 기반 결제)", summary.unallocatedCharged],
    ["검산(메뉴 배분 + 미배분)", summary.menuPaidRevenue + summary.unallocatedCharged],
    ["현장 거래 완료 건수", summary.counterSale.completedCount],
    ["현장 거래 취소 건수", summary.counterSale.cancelledCount],
    ["쿠폰 사용 건수", summary.coupon.redeemedCount],
    ["쿠폰 사용 취소 건수", summary.coupon.cancelledCount],
    ["취소 주문 수", summary.cancelledOrderCount],
    ["거부 주문 수", summary.rejectedOrderCount],
    [],
    ["결제수단", "순매출"],
    ...summary.byMethod.map((m) => [m.method, m.amount]),
    [],
    ["메뉴", "판매수량", "주문액(정가)", "실제 수납", "쿠폰 무료 제공"],
    ...summary.menuSales.map((m) => [m.name, m.quantitySold, m.orderAmount, m.paidRevenue, m.couponFreeCount]),
    [],
    ["테이블 번호", "순매출"],
    ...summary.byTable.map((t) => [t.tableNumber, t.revenue]),
  ];

  const csv = toCsv(
    ["항목", "값1", "값2", "값3", "값4"],
    rows.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? "", r[3] ?? "", r[4] ?? ""]),
  );
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
    ["실제 매출(순매출)", preview.totalRevenue],
    ["  ├ 테이블", preview.byChannel.table],
    ["  └ 현장", preview.byChannel.counter],
    ["총 할인", preview.totalDiscount],
    ["  ├ 일반 할인", preview.manualDiscount],
    ["  └ 쿠폰 할인(무료 제공)", preview.couponDiscount],
    ["메뉴 배분 수납", preview.menuPaidRevenue],
    ["미배분 수납(게임 이용료 등)", preview.unallocatedCharged],
    ["검산(메뉴 배분 + 미배분)", preview.menuPaidRevenue + preview.unallocatedCharged],
    ["현장 거래 완료/취소", `${preview.counterSale.completedCount} / ${preview.counterSale.cancelledCount}`],
    ["쿠폰 사용/사용취소", `${preview.coupon.redeemedCount} / ${preview.coupon.cancelledCount}`],
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
    [],
    ["정리 안 된 현장 거래", "상태", "수납액"],
    ...preview.openCounterSales.map((s) => [
      `#${s.saleNo}`,
      [s.pickupPending ? "미수령" : "", s.refundNeeded ? "환불 필요" : ""].filter(Boolean).join(" / "),
      s.netChargedAmount,
    ]),
  ];

  const csv = toCsv(["항목", "값1", "값2"], rows.map((r) => [r[0] ?? "", r[1] ?? "", r[2] ?? ""]));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="closing.csv"');
  res.send(csv);
});
