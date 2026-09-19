import type { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma.js";
import { isProduction } from "../env.js";
import type { StaffRole } from "../types/domain.js";

export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

const UNAUTHENTICATED = { status: 401 as const, error: "로그인이 필요합니다." };

/**
 * 모든 직원 API가 통과하는 단일 인증 게이트(요구사항2.md §2.3).
 *
 * 1) 세션에 staffUserId가 있는가
 * 2) StaffUser를 DB에서 다시 조회 (세션에 캐시된 role은 신뢰하지 않는다)
 * 3) isActive === true
 * 4) session.authVersion === user.authVersion  ← role 변경/비활성화/비밀번호 변경 즉시 무효화
 *
 * 통과하면 req.staff에 "지금 이 순간의 DB 상태"를 실어 다음 미들웨어로 넘긴다.
 */
export async function loadStaff(req: Request, res: Response, next: NextFunction) {
  const staffUserId = req.session.staffUserId;
  if (!staffUserId) {
    res.status(UNAUTHENTICATED.status).json({ error: UNAUTHENTICATED.error });
    return;
  }

  const user = await prisma.staffUser.findUnique({ where: { id: staffUserId } });
  if (!user || !user.isActive || req.session.authVersion !== user.authVersion) {
    // 세션이 더 이상 유효하지 않다 — 흔적을 남기지 않고 즉시 폐기한다.
    req.session.destroy(() => {
      res.status(UNAUTHENTICATED.status).json({ error: UNAUTHENTICATED.error });
    });
    return;
  }

  req.staff = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role as StaffRole,
    isActive: user.isActive,
    mustResetPassword: user.mustResetPassword,
    mfaEnabled: user.mfaEnabled,
    authVersion: user.authVersion,
  };
  next();
}

/**
 * mustResetPassword / ADMIN MFA 미설정 상태에서 일반 업무 API 접근을 차단한다
 * (요구사항2.md §2.4, §2.5.1). 허용 경로는 auth.routes.ts가 이 미들웨어 앞에 배치한다.
 *
 * ADMIN MFA 강제는 production 정책이다 — 개발/E2E 환경은 인증 앱 없이도 화면을 돌릴 수 있어야 한다.
 */
export function requireOnboardingComplete(req: Request, res: Response, next: NextFunction) {
  const staff = req.staff!;
  if (staff.mustResetPassword) {
    res.status(403).json({
      error: "비밀번호를 먼저 변경해 주세요.",
      code: "PASSWORD_RESET_REQUIRED",
    });
    return;
  }
  if (isProduction && staff.role === "ADMIN" && !staff.mfaEnabled) {
    res.status(403).json({
      error: "관리자 계정은 2단계 인증(MFA) 설정을 마쳐야 사용할 수 있어요.",
      code: "MFA_SETUP_REQUIRED",
    });
    return;
  }
  next();
}

/**
 * 서버 DB의 현재 role만 신뢰한다(클라이언트가 보내는 값은 물론, 세션 캐시도 신뢰하지 않음).
 * ADMIN은 하위 역할 화면도 그대로 사용할 수 있다(기존 동작 유지).
 */
export function requireRole(...allowed: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.staff?.role;
    if (!role) {
      res.status(UNAUTHENTICATED.status).json({ error: UNAUTHENTICATED.error });
      return;
    }
    if (!allowed.includes(role) && role !== "ADMIN") {
      res.status(403).json({ error: "권한이 없습니다." });
      return;
    }
    next();
  };
}

/** 인증만 필요하고 역할 제한은 없는 API용(예: 공통 운영 설정 조회). */
export const requireStaff = [loadStaff, requireOnboardingComplete];

/**
 * 역할별 라우터가 `router.use(...)`에 그대로 넘기는 표준 게이트.
 *
 * 순서가 곧 보안이다: DB에서 계정을 다시 읽고(loadStaff) → 온보딩(비밀번호 변경/MFA) 상태를
 * 확인한 뒤(requireOnboardingComplete) → 현재 DB role로 인가한다(requireRole).
 * 개별 라우트가 권한 검사를 중복 작성하지 않도록 한 곳에 모은다(요구사항2.md §13).
 */
export function staffGate(...allowed: StaffRole[]) {
  return [loadStaff, requireOnboardingComplete, requireRole(...allowed)];
}

export function isElevated(req: Request): boolean {
  const until = req.session.elevatedUntil;
  return typeof until === "number" && until > Date.now();
}

/**
 * 고위험 작업 step-up 재인증 게이트(요구사항2.md §2.5.2).
 * POST /api/staff/step-up 으로 비밀번호(+ MFA 사용 시 TOTP)를 다시 확인한 뒤 5분간만 통과한다.
 */
export function requireStepUp(req: Request, res: Response, next: NextFunction) {
  if (!isElevated(req)) {
    res.status(403).json({
      error: "보안을 위해 비밀번호를 다시 확인해 주세요.",
      code: "STEP_UP_REQUIRED",
    });
    return;
  }
  next();
}
