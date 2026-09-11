import type { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma.js";

export const TABLE_SESSION_COOKIE = "boardbite_table_token";

const CLOSED_MESSAGE = "현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요.";

/**
 * 손님 API 공통 게이트. docs/adr/0004-table-token.md의 검증 체크리스트를 그대로 구현한다.
 * 1) 쿠키의 토큰이 유효한 TableSession을 가리키는가
 * 2) TableSession.status가 ACTIVE 또는 PAID_PENDING_SERVICE인가(완납 후에도 주문 현황/직원호출은 볼 수 있어야 함)
 * 3) 연결된 Table.status가 OPEN 또는 SETTLING인가
 * 클라이언트가 body/쿼리로 보내는 테이블 식별자는 절대 신뢰하지 않는다 — 오직 쿠키 → 서버 조회 결과만 신뢰한다.
 *
 * 신규 주문 생성처럼 "완전히 ACTIVE + OPEN이어야만" 허용되는 동작은 이 미들웨어 통과 후
 * `requireOrderableSession`으로 한 번 더 좁혀서 검사한다.
 */
export async function requireTableSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[TABLE_SESSION_COOKIE];
  if (!token || typeof token !== "string") {
    res.status(403).json({ error: CLOSED_MESSAGE });
    return;
  }

  const session = await prisma.tableSession.findUnique({
    where: { token },
    include: { table: true },
  });

  const sessionOk = session?.status === "ACTIVE" || session?.status === "PAID_PENDING_SERVICE";
  const tableOk = session?.table.status === "OPEN" || session?.table.status === "SETTLING";

  if (!session || !sessionOk || !tableOk) {
    res.status(403).json({ error: CLOSED_MESSAGE });
    return;
  }

  req.tableSession = {
    id: session.id,
    tableId: session.tableId,
    tableNumber: session.table.number,
    sessionStatus: session.status as "ACTIVE" | "PAID_PENDING_SERVICE",
    tableOrdersLocked: session.table.ordersLocked,
  };
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
