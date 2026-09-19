import type { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma.js";
import { CUSTOMER_SESSION_COOKIE, resolveCustomerSession } from "../services/customerSession.js";

export { CUSTOMER_SESSION_COOKIE };

const CLOSED_MESSAGE = "현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요.";

/**
 * 손님 API 공통 게이트(요구사항2.md §2.2).
 *
 * 쿠키의 raw token → CustomerDeviceSession → TableSession → Table 순으로 서버가 직접 확인한다.
 * 핵심 변경: 물리 NFC/QR에 인쇄된 `Table.publicSlug`는 더 이상 인증 토큰이 아니다. 손님은
 * 반드시 이번 세션에만 유효한 join code를 입력해 device session을 발급받아야 하며, 예전에
 * 저장해둔 `/t/<slug>` 링크만으로는 미래의 어떤 세션에도 들어갈 수 없다.
 *
 * 클라이언트가 body/쿼리로 보내는 테이블 식별자는 절대 신뢰하지 않는다.
 */
export async function requireTableSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[CUSTOMER_SESSION_COOKIE];
  if (!token || typeof token !== "string") {
    res.status(403).json({ error: CLOSED_MESSAGE, code: "JOIN_REQUIRED" });
    return;
  }

  const resolved = await resolveCustomerSession(token);
  if (!resolved) {
    res.clearCookie(CUSTOMER_SESSION_COOKIE, { path: "/" });
    res.status(403).json({ error: CLOSED_MESSAGE, code: "JOIN_REQUIRED" });
    return;
  }

  req.tableSession = {
    id: resolved.tableSessionId,
    tableId: resolved.tableId,
    tableNumber: resolved.tableNumber,
    sessionStatus: resolved.sessionStatus,
    tableOrdersLocked: resolved.tableOrdersLocked,
    deviceSessionId: resolved.deviceSessionId,
  };

  // 마지막 접속 시각은 정리 작업/운영 확인용 — 실패해도 요청을 막지 않는다.
  void prisma.customerDeviceSession
    .update({ where: { id: resolved.deviceSessionId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  next();
}

/**
 * 신규 주문 생성처럼 완전히 정상 영업 중(ACTIVE + OPEN + 잠금 없음 + 전체 주문기능 활성)이어야만
 * 허용되는 동작에 추가로 적용한다. requireTableSession 다음에 연결해서 쓴다.
 */
export async function requireOrderableSession(req: Request, res: Response, next: NextFunction) {
  const ts = req.tableSession;
  if (!ts || ts.sessionStatus !== "ACTIVE") {
    res.status(409).json({ error: "결제가 완료되어 추가 주문을 받지 않아요." });
    return;
  }
  if (ts.tableOrdersLocked) {
    res.status(409).json({ error: "지금은 이 테이블에서 주문을 받을 수 없어요. 직원에게 문의해 주세요." });
    return;
  }
  const settings = await prisma.operationSettings.findUnique({ where: { id: 1 } });
  if (settings && !settings.orderingEnabled) {
    res.status(409).json({ error: "지금은 주문을 받지 않고 있어요. 잠시 후 다시 시도해 주세요." });
    return;
  }
  next();
}
