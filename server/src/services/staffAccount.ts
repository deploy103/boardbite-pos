import { prisma } from "../prisma.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { validatePasswordPolicy } from "../env.js";
import { recordAuditLog } from "./auditLog.js";
import type { StaffRole } from "../types/domain.js";

export class StaffAccountError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * 계정 보안 상태가 바뀌면 authVersion을 올려 그 계정의 "기존 모든 세션"을 다음 요청부터
 * 401로 만든다(요구사항2.md §2.3). StaffSession 행도 함께 지워 즉시 효력이 생기게 한다.
 *
 * 증가 조건: 비밀번호 변경 / ADMIN 비밀번호 초기화 / role 변경 / 계정 비활성화 / MFA 변경.
 */
async function invalidateAllSessions(staffUserId: string): Promise<void> {
  // 세션 데이터는 JSON 문자열이므로 staffUserId 포함 여부로 골라낸다(단일 프로세스·소규모 운영 기준).
  await prisma.staffSession.deleteMany({ where: { data: { contains: `"staffUserId":"${staffUserId}"` } } });
}

export async function bumpAuthVersion(staffUserId: string): Promise<number> {
  const updated = await prisma.staffUser.update({
    where: { id: staffUserId },
    data: { authVersion: { increment: 1 } },
    select: { authVersion: true },
  });
  await invalidateAllSessions(staffUserId);
  return updated.authVersion;
}

export interface ChangePasswordInput {
  staffUserId: string;
  currentPassword: string;
  newPassword: string;
}

/** 본인 비밀번호 변경(요구사항2.md §2.4). 성공 시 mustResetPassword 해제 + 전 세션 무효화. */
export async function changeOwnPassword(input: ChangePasswordInput): Promise<void> {
  const user = await prisma.staffUser.findUnique({ where: { id: input.staffUserId } });
  if (!user || !user.isActive) throw new StaffAccountError("로그인이 필요합니다.", 401);

  const currentOk = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!currentOk) {
    throw new StaffAccountError("현재 비밀번호가 올바르지 않습니다.", 400);
  }
  if (input.currentPassword === input.newPassword) {
    throw new StaffAccountError("이전과 다른 비밀번호를 사용해 주세요.", 400);
  }

  const problem = validatePasswordPolicy(input.newPassword, { username: user.username, role: user.role });
  if (problem) throw new StaffAccountError(problem, 400);

  await prisma.staffUser.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      mustResetPassword: false,
      authVersion: { increment: 1 },
    },
  });
  await invalidateAllSessions(user.id);

  await recordAuditLog({
    actorType: "STAFF",
    actorId: user.id,
    action: "USER_PASSWORD_CHANGED",
    targetType: "StaffUser",
    targetId: user.id,
  });
}

/** ADMIN에 의한 비밀번호 초기화. 대상 사용자는 다음 로그인에서 반드시 비밀번호를 바꿔야 한다. */
export async function adminResetPassword(input: {
  targetUserId: string;
  newPassword: string;
  actorId: string;
}): Promise<void> {
  const target = await prisma.staffUser.findUnique({ where: { id: input.targetUserId } });
  if (!target) throw new StaffAccountError("존재하지 않는 사용자입니다.", 404);

  const problem = validatePasswordPolicy(input.newPassword, { username: target.username, role: target.role });
  if (problem) throw new StaffAccountError(problem, 400);

  await prisma.staffUser.update({
    where: { id: target.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      mustResetPassword: true,
      authVersion: { increment: 1 },
    },
  });
  await invalidateAllSessions(target.id);

  await recordAuditLog({
    actorType: "STAFF",
    actorId: input.actorId,
    action: "USER_PASSWORD_RESET",
    targetType: "StaffUser",
    targetId: target.id,
  });
}

export interface UpdateStaffUserInput {
  targetUserId: string;
  actorId: string;
  displayName?: string;
  role?: StaffRole;
  isActive?: boolean;
}

/**
 * ADMIN의 사용자 정보 수정. role/isActive처럼 보안에 직결되는 변경에서만 authVersion을 올린다
 * (displayName만 바꾸는 경우까지 강제 로그아웃시키면 운영만 불편해진다).
 */
export async function updateStaffUser(input: UpdateStaffUserInput) {
  const target = await prisma.staffUser.findUnique({ where: { id: input.targetUserId } });
  if (!target) throw new StaffAccountError("존재하지 않는 사용자입니다.", 404);

  const roleChanged = input.role !== undefined && input.role !== target.role;
  const deactivated = input.isActive === false && target.isActive;
  const reactivated = input.isActive === true && !target.isActive;
  const securityRelevant = roleChanged || deactivated || reactivated;

  if (deactivated) {
    // 마지막 활성 ADMIN을 끄면 아무도 관리 기능에 들어갈 수 없다.
    const otherActiveAdmins = await prisma.staffUser.count({
      where: { role: "ADMIN", isActive: true, id: { not: target.id } },
    });
    if (target.role === "ADMIN" && otherActiveAdmins === 0) {
      throw new StaffAccountError("마지막 관리자 계정은 비활성화할 수 없습니다.", 409);
    }
  }
  if (roleChanged && target.role === "ADMIN") {
    const otherActiveAdmins = await prisma.staffUser.count({
      where: { role: "ADMIN", isActive: true, id: { not: target.id } },
    });
    if (otherActiveAdmins === 0) {
      throw new StaffAccountError("마지막 관리자 계정의 역할은 변경할 수 없습니다.", 409);
    }
  }

  const updated = await prisma.staffUser.update({
    where: { id: target.id },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(securityRelevant ? { authVersion: { increment: 1 } } : {}),
    },
  });
  if (securityRelevant) await invalidateAllSessions(target.id);

  if (roleChanged) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: input.actorId,
      action: "USER_ROLE_CHANGED",
      targetType: "StaffUser",
      targetId: target.id,
      metadata: { from: target.role, to: input.role },
    });
  }
  if (deactivated) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: input.actorId,
      action: "USER_DISABLED",
      targetType: "StaffUser",
      targetId: target.id,
    });
  }
  if (reactivated) {
    await recordAuditLog({
      actorType: "STAFF",
      actorId: input.actorId,
      action: "USER_ENABLED",
      targetType: "StaffUser",
      targetId: target.id,
    });
  }

  return updated;
}

/** 오래된 로그인 시도/만료 세션 정리(요구사항2.md §4.1 maintenance task). */
export async function cleanupAuthArtifacts(options?: { loginAttemptRetentionMs?: number }): Promise<{
  loginAttempts: number;
  staffSessions: number;
}> {
  const retention = options?.loginAttemptRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
  const [attempts, sessions] = await Promise.all([
    prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - retention) } } }),
    prisma.staffSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  ]);
  return { loginAttempts: attempts.count, staffSessions: sessions.count };
}
