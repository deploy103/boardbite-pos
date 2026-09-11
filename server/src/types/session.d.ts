import "express-session";

declare module "express-session" {
  interface SessionData {
    staffUserId?: string;
    role?: "ADMIN" | "FRONT" | "POS" | "SERVING";
  }
}

declare global {
  namespace Express {
    interface Request {
      /** docs/adr/0004-table-token.md — 손님 쿠키에서 유도된 현재 활성 테이블 세션 */
      tableSession?: {
        id: string;
        tableId: string;
        tableNumber: number;
      };
    }
  }
}

export {};
