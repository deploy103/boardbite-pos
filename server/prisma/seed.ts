import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const prisma = new PrismaClient();

/**
 * 부트스트랩 계정 시드. AGENTS.md §6.5 — "환경변수 계정은 최초/부트스트랩 운영 계정으로 취급".
 * 이미 존재하는 아이디는 건드리지 않는다(운영자가 이미 비밀번호를 바꿨을 수 있으므로 덮어쓰지 않음).
 */
async function upsertBootstrap(username: string, password: string, displayName: string, role: "ADMIN" | "FRONT" | "POS" | "SERVING") {
  const existing = await prisma.staffUser.findUnique({ where: { username } });
  if (existing) {
    console.log(`[seed] ${username} 계정이 이미 존재해 건너뜁니다.`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.staffUser.create({
    data: { username, passwordHash, displayName, role, isBootstrap: true, mustResetPassword: true },
  });
  console.log(`[seed] 부트스트랩 계정 생성: ${username} (${role})`);
}

async function main() {
  const {
    ADMINID,
    ADMINPASSWORD,
    FRONTID,
    FRONTPW,
    POSID,
    POSPW,
    SERVING_ID,
    SERVING_PW,
  } = process.env;

  if (!ADMINID || !ADMINPASSWORD || !FRONTID || !FRONTPW || !POSID || !POSPW || !SERVING_ID || !SERVING_PW) {
    throw new Error(".env에 부트스트랩 계정 환경변수가 모두 설정되어야 합니다. .env.example을 참고하세요.");
  }

  await upsertBootstrap(ADMINID, ADMINPASSWORD, "관리자", "ADMIN");
  await upsertBootstrap(FRONTID, FRONTPW, "프론트", "FRONT");
  await upsertBootstrap(POSID, POSPW, "주방", "POS");
  await upsertBootstrap(SERVING_ID, SERVING_PW, "서빙", "SERVING");

  const gamePlanCount = await prisma.gameTimePlan.count();
  if (gamePlanCount === 0) {
    await prisma.gameTimePlan.createMany({
      data: [
        { name: "10분", minutes: 10, price: 1000 },
        { name: "20분", minutes: 20, price: 1800 },
        { name: "30분", minutes: 30, price: 2500 },
      ],
    });
    console.log("[seed] 기본 보드게임 이용권 3종 생성");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
