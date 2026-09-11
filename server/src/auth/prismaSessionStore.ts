import { Store } from "express-session";
import type { SessionData } from "express-session";
import { prisma } from "../prisma.js";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12시간 (docs/adr/0003-auth-session.md)

function getExpiry(session: SessionData): Date {
  if (session.cookie?.expires) return new Date(session.cookie.expires);
  return new Date(Date.now() + DEFAULT_TTL_MS);
}

/**
 * 직원 세션을 SQLite(Prisma)에 저장하는 store.
 * 로그아웃/역할변경 시 destroy()로 즉시 무효화되어야 하므로(docs/adr/0003-auth-session.md),
 * 별도 인메모리 캐시 없이 매 요청 DB를 조회한다.
 */
export class PrismaSessionStore extends Store {
  async get(sid: string, callback: (err: unknown, session?: SessionData | null) => void) {
    try {
      const row = await prisma.staffSession.findUnique({ where: { sid } });
      if (!row || row.expiresAt < new Date()) {
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.data) as SessionData);
    } catch (err) {
      callback(err);
    }
  }

  async set(sid: string, session: SessionData, callback?: (err?: unknown) => void) {
    try {
      const data = JSON.stringify(session);
      const expiresAt = getExpiry(session);
      await prisma.staffSession.upsert({
        where: { sid },
        create: { sid, data, expiresAt },
        update: { data, expiresAt },
      });
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  async destroy(sid: string, callback?: (err?: unknown) => void) {
    try {
      await prisma.staffSession.deleteMany({ where: { sid } });
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  async touch(sid: string, session: SessionData, callback?: (err?: unknown) => void) {
    try {
      const expiresAt = getExpiry(session);
      await prisma.staffSession.updateMany({ where: { sid }, data: { expiresAt } });
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }
}
