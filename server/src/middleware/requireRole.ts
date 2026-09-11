import type { Request, Response, NextFunction } from "express";

type Role = "ADMIN" | "FRONT" | "POS" | "SERVING";

/**
 * 서버 세션에 저장된 role만 신뢰한다(클라이언트가 보내는 값은 절대 신뢰하지 않음).
 * docs/SECURITY.md §1 — Role escalation / 관리자 API 직접 호출 대응.
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.session.role;
    if (!req.session.staffUserId || !role) {
      res.status(401).json({ error: "로그인이 필요합니다." });
      return;
    }
    if (!allowed.includes(role) && role !== "ADMIN") {
      res.status(403).json({ error: "권한이 없습니다." });
      return;
    }
    next();
  };
}

export function requireStaff(req: Request, res: Response, next: NextFunction) {
  if (!req.session.staffUserId) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return;
  }
  next();
}
