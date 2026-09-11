import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TEST_DB_FILE = path.resolve(__dirname, "../prisma/test.db");
// connection_limit=1: 운영과 동일한 동시성 제어 방식을 테스트에서도 재현한다.
// docs/adr/0005-sqlite-write-concurrency.md 참고.
export const TEST_DATABASE_URL = `file:${TEST_DB_FILE}?connection_limit=1`;
