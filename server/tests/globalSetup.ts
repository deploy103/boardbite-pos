import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
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

  // 결제 테스트 등에서 공통으로 필요한 기준 데이터(운영 설정 싱글턴, 기본 결제수단)를
  // 프로덕션 seed.ts와 동일하게 미리 채워둔다.
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  await prisma.operationSettings.create({ data: { id: 1 } });
  await prisma.paymentMethod.createMany({
    data: [
      { code: "CASH", name: "현금", isCash: true, sortOrder: 0 },
      { code: "CARD", name: "카드", isCash: false, sortOrder: 1 },
      { code: "OTHER", name: "기타", isCash: false, sortOrder: 2 },
    ],
  });
  await prisma.$disconnect();

  return async () => {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const p = TEST_DB_FILE + suffix;
      if (existsSync(p)) rmSync(p);
    }
  };
}
