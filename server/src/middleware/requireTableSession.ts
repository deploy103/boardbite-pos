import type { Request, Response, NextFunction } from "express";
import { prisma } from "../prisma.js";

export const TABLE_SESSION_COOKIE = "boardbite_table_token";

/**
 * 손님 API 공통 게이트. docs/adr/0004-table-token.md의 검증 체크리스트를 그대로 구현한다.
 * 1) 쿠키의 토큰이 유효한 TableSession을 가리키는가
 * 2) TableSession.status === ACTIVE 인가
 * 3) 연결된 Table.status === OPEN 인가
 * 클라이언트가 body/쿼리로 보내는 테이블 식별자는 절대 신뢰하지 않는다 — 오직 쿠키 → 서버 조회 결과만 신뢰한다.
 */
export async function requireTableSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[TABLE_SESSION_COOKIE];
  if (!token || typeof token !== "string") {
    res.status(403).json({ error: "현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요." });
    return;
  }

  const session = await prisma.tableSession.findUnique({
    where: { token },
    include: { table: true },
  });

  if (!session || session.status !== "ACTIVE" || session.table.status !== "OPEN") {
    res.status(403).json({ error: "현재 주문 가능한 테이블이 아닙니다. 입구에서 자리 배정을 먼저 받아주세요." });
    return;
  }

  req.tableSession = {
    id: session.id,
    tableId: session.tableId,
    tableNumber: session.table.number,
  };
  next();
}
