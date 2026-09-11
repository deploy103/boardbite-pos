import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { verifyPassword } from "../auth/password.js";
import { assertLoginAllowed, recordLoginAttempt } from "../auth/loginGuard.js";
import { recordAuditLog } from "../services/auditLog.js";
import { asStaffRole } from "../types/domain.js";

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
    await recordAuditLog({
      actorType: "STAFF",
      actorId: user?.id ?? null,
      action: "AUTH_LOGIN_FAILED",
      targetType: "StaffUser",
      targetId: user?.id ?? null,
      metadata: { username },
    });
    res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  await recordLoginAttempt({ username, succeeded: true, ip, staffUserId: user.id });
  await prisma.staffUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  // 세션 고정(session fixation) 방지: 로그인 시점에 세션 ID를 재발급한다.
  // docs/adr/0003-auth-session.md
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
      return;
    }
    req.session.staffUserId = user.id;
    req.session.role = asStaffRole(user.role);
    req.session.save(async (saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
        return;
      }
      await recordAuditLog({
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
        redirectTo: ROLE_REDIRECT[user.role] ?? "/",
      });
    });
  });
});

authRouter.post("/logout", (req, res) => {
  const staffUserId = req.session.staffUserId;
  req.session.destroy(async (err) => {
    res.clearCookie("boardbite.sid");
    if (!err && staffUserId) {
      await recordAuditLog({ actorType: "STAFF", actorId: staffUserId, action: "AUTH_LOGOUT" });
    }
    res.json({ ok: true });
  });
});

authRouter.get("/me", async (req, res) => {
  if (!req.session.staffUserId) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return;
  }
  const user = await prisma.staffUser.findUnique({ where: { id: req.session.staffUserId } });
  if (!user || !user.isActive) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return;
  }
  res.json({
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    mustResetPassword: user.mustResetPassword,
  });
});
