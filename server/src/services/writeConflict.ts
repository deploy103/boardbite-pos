import { Prisma } from "@prisma/client";

/**
 * SQLite 쓰기 충돌 유한 재시도(요구사항.md §11 — "BUSY/충돌은 유한 재시도하고 모두 재검증한다").
 *
 * SQLite는 쓰기를 직렬화하지만, 오래된 읽기 스냅샷을 쥔 트랜잭션이 쓰기로 전환하면 충돌한다
 * (https://www.sqlite.org/isolation.html). 설치된 Prisma 5.22는 이때
 * PrismaClientKnownRequestError(P2034 write conflict / P2024 pool timeout)를 던진다.
 *
 * 핵심: 재시도는 **트랜잭션 전체를 처음부터 다시 실행**한다. 견적 재계산·쿠폰 상태 확인·가격 검증이
 * 새 트랜잭션 안에서 모두 다시 일어나므로, 낡은 값으로 결제가 확정되는 일은 없다.
 * P2002(UNIQUE 위반)는 재시도해도 결과가 같으므로 여기서 다루지 않고 호출자가 따로 처리한다.
 */
const WRITE_CONFLICT_CODES = new Set(["P2034", "P2024"]);
const MAX_RETRIES = 4;

export function isWriteConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && WRITE_CONFLICT_CODES.has(err.code)) return true;
  // 드라이버가 코드로 감싸지 못한 경우를 대비해 SQLite 원문 메시지도 함께 본다.
  const message = err instanceof Error ? err.message : "";
  return /SQLITE_BUSY|database is locked|write conflict/i.test(message);
}

export async function withWriteConflictRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isWriteConflict(err)) throw err;
      lastError = err;
      // 짧은 지수 백오프 + 지터 — 두 단말이 같은 순간에 재시도해 또 부딪히는 것을 피한다.
      const delay = 25 * 2 ** attempt + Math.floor(Math.random() * 25);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
