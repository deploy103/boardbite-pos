import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DB_FILE, TEST_DATABASE_URL } from "./testDbPath.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default async function globalSetup() {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const p = TEST_DB_FILE + suffix;
    if (existsSync(p)) rmSync(p);
  }

  execSync("npx prisma migrate deploy", {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });

  return async () => {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const p = TEST_DB_FILE + suffix;
      if (existsSync(p)) rmSync(p);
    }
  };
}
