import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TEST_DB_FILE = path.resolve(__dirname, "../prisma/test.db");
export const TEST_DATABASE_URL = `file:${TEST_DB_FILE}`;
