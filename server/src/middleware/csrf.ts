import type { Request, Response, NextFunction } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * SameSite 쿠키만으로는 CSRF를 충분히 막지 못한다는 OWASP 권고에 따라(docs/RESEARCH.md Agent D),
 * 상태 변경 요청에는 커스텀 헤더를 추가로 요구한다. 단순 HTML <form> 기반 CSRF는
 * 브라우저가 임의 커스텀 헤더를 실어 보낼 수 없으므로 이 요구만으로 차단된다.
 */
export function requireCustomHeader(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.get("X-BoardBite-Client") !== "1") {
    res.status(403).json({ error: "잘못된 요청입니다." });
    return;
  }
  next();
}
