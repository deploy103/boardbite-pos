import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { verifyPassword } from "../auth/password.js";
import {
  assertLoginAllowed,
  clearFailedAttempts,
  detectDistributedAccountAttack,
  recordLoginAttempt,
} from "../auth/loginGuard.js";
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from "../auth/totp.js";
import { openSecret, sealSecret } from "../auth/secretBox.js";
import { recordAuditLog, recordAuditLogBestEffort } from "../services/auditLog.js";
import { changeOwnPassword, StaffAccountError } from "../services/staffAccount.js";
import { asStaffRole } from "../types/domain.js";
import { isProduction } from "../env.js";
import { loadStaff, requireOnboardingComplete, STEP_UP_WINDOW_MS } from "../middleware/requireRole.js";
import { getSettings } from "../services/settings.js";

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

const ROLE_REDIRECT: Record<string, string> = {
  ADMIN: "/admin",
  FRONT: "/front",
  POS: "/pos",
  SERVING: "/serving",
};

/** 아이디/비밀번호 오류를 구분하지 않는 단일 문구 — 계정 존재 여부를 노출하지 않는다. */
const INVALID_CREDENTIALS = "아이디 또는 비밀번호가 올바르지 않습니다.";

/** MFA 중간 상태가 무한정 살아있지 않도록 제한한다. */
const PENDING_MFA_TTL_MS = 5 * 60 * 1000;

function redirectForUser(user: { role: string; mustResetPassword: boolean; mfaEnabled: boolean }): string {
  if (user.mustResetPassword) return "/staff/change-password";
  if (isProduction && user.role === "ADMIN" && !user.mfaEnabled) return "/staff/mfa-setup";
  return ROLE_REDIRECT[user.role] ?? "/";
}

// 클라이언트가 role을 선택하지 않는다(AGENTS.md §6.4) — 서버가 DB의 역할로만 리다이렉트를 결정한다.
authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "아이디와 비밀번호를 입력해 주세요." });
    return;
  }
  const { username, password } = parsed.data;
  const ip = req.ip;

  const gate = await assertLoginAllowed(username, ip);
  if (!gate.allowed) {
    res.status(429).json({ error: gate.reason });
    return;
  }

  const user = await prisma.staffUser.findUnique({ where: { username } });
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !user.isActive || !passwordOk) {
    await recordLoginAttempt({ username, succeeded: false, ip, staffUserId: user?.id });
    await recordAuditLogBestEffort({
      actorType: "STAFF",
      actorId: user?.id ?? null,
      action: "AUTH_LOGIN_FAILED",
      targetType: "StaffUser",
      targetId: user?.id ?? null,
      metadata: { username },
    });
    if (await detectDistributedAccountAttack(username)) {
      await recordAuditLogBestEffort({
        actorType: "SYSTEM",
        action: "AUTH_DISTRIBUTED_ATTACK_SUSPECTED",
        targetType: "StaffUser",
        targetId: user?.id ?? null,
        metadata: { username },
      });
    }
    res.status(401).json({ error: INVALID_CREDENTIALS });
    return;
  }

  await recordLoginAttempt({ username, succeeded: true, ip, staffUserId: user.id });
  await clearFailedAttempts(username, ip);
  await prisma.staffUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  // ADMIN + MFA 활성 계정은 아직 완전한 세션을 만들지 않는다(요구사항2.md §2.5.1).
  if (user.mfaEnabled) {
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
        return;
      }
      req.session.pendingMfaUserId = user.id;
      req.session.pendingMfaStartedAt = Date.now();
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
          return;
        }
        res.json({ mfaRequired: true, redirectTo: "/staff/mfa" });
      });
    });
    return;
  }

  establishSession(req, res, user);
});

type LoginUser = { id: string; role: string; displayName: string; mustResetPassword: boolean; mfaEnabled: boolean; authVersion: number };

/** 세션 고정 방지를 위해 항상 세션 ID를 재발급한 뒤 인증 정보를 기록한다. */
function establishSession(req: import("express").Request, res: import("express").Response, user: LoginUser) {
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
      return;
    }
    req.session.staffUserId = user.id;
    req.session.authVersion = user.authVersion;
    req.session.role = asStaffRole(user.role);
    req.session.save(async (saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
        return;
      }
      await recordAuditLogBestEffort({
        actorType: "STAFF",
        actorId: user.id,
        action: "AUTH_LOGIN_SUCCESS",
        targetType: "StaffUser",
        targetId: user.id,
      });
      res.json({
        role: user.role,
        displayName: user.displayName,
        mustResetPassword: user.mustResetPassword,
        mfaEnabled: user.mfaEnabled,
        redirectTo: redirectForUser(user),
      });
    });
  });
}

const totpSchema = z.object({ token: z.string().min(6).max(8) });

/** 로그인 2단계 — pending 상태에서 TOTP를 확인해야 실제 권한 세션이 만들어진다. */
authRouter.post("/mfa/verify", async (req, res) => {
  const parsed = totpSchema.safeParse(req.body);
  const pendingUserId = req.session.pendingMfaUserId;
  const startedAt = req.session.pendingMfaStartedAt ?? 0;

  if (!pendingUserId || Date.now() - startedAt > PENDING_MFA_TTL_MS) {
    res.status(401).json({ error: "인증 시간이 지났어요. 다시 로그인해 주세요." });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: "6자리 인증번호를 입력해 주세요." });
    return;
  }

  const user = await prisma.staffUser.findUnique({ where: { id: pendingUserId } });
  if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecretEncrypted) {
    res.status(401).json({ error: "인증에 실패했어요. 다시 로그인해 주세요." });
    return;
  }

  const secret = openSecret(user.mfaSecretEncrypted);
  if (!secret || !verifyTotp(secret, parsed.data.token)) {
    await recordAuditLogBestEffort({
      actorType: "STAFF",
      actorId: user.id,
      action: "AUTH_MFA_FAILED",
      targetType: "StaffUser",
      targetId: user.id,
    });
    res.status(401).json({ error: "인증번호가 올바르지 않아요." });
    return;
  }

  establishSession(req, res, user);
});

authRouter.post("/logout", (req, res) => {
  const staffUserId = req.session.staffUserId;
  req.session.destroy(async (err) => {
    res.clearCookie("boardbite.sid");
    if (!err && staffUserId) {
      await recordAuditLogBestEffort({ actorType: "STAFF", actorId: staffUserId, action: "AUTH_LOGOUT" });
    }
    res.json({ ok: true });
  });
});

/**
 * 현재 로그인 상태. 항상 DB의 현재 값을 그대로 반환한다(요구사항2.md §2.3) —
 * 세션에 캐시된 role은 쓰지 않는다. mustResetPassword/MFA 미설정 상태에서도 호출 가능해야
 * 클라이언트가 어느 화면으로 보낼지 판단할 수 있으므로 loadStaff까지만 적용한다.
 */
authRouter.get("/me", loadStaff, async (req, res) => {
  const staff = req.staff!;
  res.json({
    username: staff.username,
    displayName: staff.displayName,
    role: staff.role,
    mustResetPassword: staff.mustResetPassword,
    mfaEnabled: staff.mfaEnabled,
    mfaSetupRequired: isProduction && staff.role === "ADMIN" && !staff.mfaEnabled,
    elevated: typeof req.session.elevatedUntil === "number" && req.session.elevatedUntil > Date.now(),
  });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/**
 * 비밀번호 변경. mustResetPassword 상태에서도 호출할 수 있어야 하므로 onboarding 게이트를
 * 적용하지 않는다(요구사항2.md §2.4의 허용 목록).
 */
authRouter.post("/change-password", loadStaff, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "현재 비밀번호와 새 비밀번호를 입력해 주세요." });
    return;
  }
  try {
    await changeOwnPassword({
      staffUserId: req.staff!.id,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });
  } catch (err) {
    if (err instanceof StaffAccountError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  // authVersion이 올라갔으므로 지금 세션도 무효다 — 안전하게 재로그인시킨다.
  const user = await prisma.staffUser.findUniqueOrThrow({ where: { id: req.staff!.id } });
  establishSession(req, res, user);
});

// ---------------------------------------------------------------------------
// TOTP MFA 설정 (요구사항2.md §2.5.1)
// ---------------------------------------------------------------------------

const mfaSetupSchema = z.object({ currentPassword: z.string().min(1).max(200) });

/** 1단계: 현재 비밀번호 재확인 후 새 secret을 발급한다. secret은 봉인된 채로만 저장된다. */
authRouter.post("/mfa/setup", loadStaff, async (req, res) => {
  const parsed = mfaSetupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "현재 비밀번호를 입력해 주세요." });
    return;
  }
  const user = await prisma.staffUser.findUniqueOrThrow({ where: { id: req.staff!.id } });
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    res.status(400).json({ error: "현재 비밀번호가 올바르지 않습니다." });
    return;
  }
  if (user.mfaEnabled) {
    res.status(409).json({ error: "이미 2단계 인증이 설정되어 있어요. 먼저 해제한 뒤 다시 설정해 주세요." });
    return;
  }

  const secret = generateTotpSecret();
  await prisma.staffUser.update({
    where: { id: user.id },
    data: { mfaSecretEncrypted: sealSecret(secret), mfaEnabled: false },
  });

  // secret/URI는 이 응답에서만 나가고 서버 로그에는 남기지 않는다.
  res.json({ secret, otpauthUri: buildOtpAuthUri(secret, user.username) });
});

/** 2단계: 사용자가 인증 앱에서 만든 6자리를 1회 확인해야 mfaEnabled=true가 된다. */
authRouter.post("/mfa/enable", loadStaff, async (req, res) => {
  const parsed = totpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "6자리 인증번호를 입력해 주세요." });
    return;
  }
  const user = await prisma.staffUser.findUniqueOrThrow({ where: { id: req.staff!.id } });
  if (!user.mfaSecretEncrypted) {
    res.status(409).json({ error: "먼저 2단계 인증 설정을 시작해 주세요." });
    return;
  }
  const secret = openSecret(user.mfaSecretEncrypted);
  if (!secret || !verifyTotp(secret, parsed.data.token)) {
    res.status(400).json({ error: "인증번호가 올바르지 않아요. 앱의 시간이 정확한지 확인해 주세요." });
    return;
  }

  await prisma.staffUser.update({ where: { id: user.id }, data: { mfaEnabled: true } });
  await recordAuditLog({
    actorType: "STAFF",
    actorId: user.id,
    action: "USER_MFA_ENABLED",
    targetType: "StaffUser",
    targetId: user.id,
  });

  // 설정 직후에는 step-up도 방금 통과한 것으로 본다(비밀번호 + TOTP를 모두 확인했으므로).
  req.session.elevatedUntil = Date.now() + STEP_UP_WINDOW_MS;
  req.session.save(() => res.json({ ok: true, redirectTo: ROLE_REDIRECT[user.role] ?? "/" }));
});

// ---------------------------------------------------------------------------
// Step-up 재인증 (요구사항2.md §2.5.2)
// ---------------------------------------------------------------------------

const stepUpSchema = z.object({
  password: z.string().min(1).max(200),
  token: z.string().max(8).optional(),
});

/**
 * 고위험 작업 직전에 호출한다. 비밀번호를 다시 확인하고, MFA가 켜진 계정은 TOTP까지 맞아야
 * `elevatedUntil`이 갱신된다. 5분이 지나면 자동으로 만료된다.
 */
authRouter.post("/step-up", loadStaff, requireOnboardingComplete, async (req, res) => {
  const parsed = stepUpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "비밀번호를 입력해 주세요." });
    return;
  }
  const user = await prisma.staffUser.findUniqueOrThrow({ where: { id: req.staff!.id } });

  const passwordOk = await verifyPassword(parsed.data.password, user.passwordHash);
  let totpOk = true;
  if (user.mfaEnabled) {
    const secret = user.mfaSecretEncrypted ? openSecret(user.mfaSecretEncrypted) : null;
    totpOk = Boolean(secret && parsed.data.token && verifyTotp(secret, parsed.data.token));
  }

  if (!passwordOk || !totpOk) {
    await recordAuditLogBestEffort({
      actorType: "STAFF",
      actorId: user.id,
      action: "AUTH_STEP_UP_FAILED",
      targetType: "StaffUser",
      targetId: user.id,
    });
    res.status(401).json({ error: "인증에 실패했어요. 다시 확인해 주세요." });
    return;
  }

  req.session.elevatedUntil = Date.now() + STEP_UP_WINDOW_MS;
  req.session.save(async (err) => {
    if (err) {
      res.status(500).json({ error: "인증 처리 중 오류가 발생했어요." });
      return;
    }
    await recordAuditLogBestEffort({
      actorType: "STAFF",
      actorId: user.id,
      action: "AUTH_STEP_UP_SUCCESS",
      targetType: "StaffUser",
      targetId: user.id,
    });
    res.json({ ok: true, elevatedUntil: req.session.elevatedUntil, mfaRequired: user.mfaEnabled });
  });
});

// 모든 직원 화면(POS/FRONT/SERVING/ADMIN)이 공통으로 참조하는 운영 설정 — 민감정보가 없으므로 role 제한 없이 공개한다.
// 값을 바꾸는 PATCH는 admin.routes.ts에서 ADMIN 전용으로만 허용한다.
authRouter.get("/settings", loadStaff, requireOnboardingComplete, async (_req, res) => {
  const settings = await getSettings();
  res.json({ settings });
});
