import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { validatePasswordPolicy } from "../src/auth/passwordPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const prisma = new PrismaClient();

/**
 * 부트스트랩 관리자 계정 시드.
 *
 * 시드가 만드는 계정은 ADMIN 하나뿐이다. FRONT/POS/SERVING은 환경변수로 만들지 않는다 —
 * 운영자가 이 관리자 계정으로 로그인해 관리자 화면에서 직접 등록한다. 그래야
 *   - 감사 로그에 "누가 이 계정을 만들었는지"가 남고,
 *   - 아무도 주인이 아닌 공용 계정(front/pos/serving)이 .env에 방치되지 않는다.
 *
 * 이미 존재하는 아이디는 건드리지 않는다(운영자가 이미 비밀번호를 바꿨을 수 있으므로 덮어쓰지 않음).
 */
async function upsertBootstrapAdmin(username: string, password: string) {
  const existing = await prisma.staffUser.findUnique({ where: { username } });
  if (existing) {
    console.log(`[seed] ${username} 계정이 이미 존재해 건너뜁니다.`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.staffUser.create({
    data: {
      username,
      passwordHash,
      displayName: "관리자",
      role: "ADMIN",
      isBootstrap: true,
      mustResetPassword: true,
    },
  });
  console.log(`[seed] 부트스트랩 관리자 계정 생성: ${username} (ADMIN)`);
  console.log("[seed] 첫 로그인에서 비밀번호 변경 + 2단계 인증(TOTP) 등록을 마쳐야 관리 기능이 열립니다.");
  console.log("[seed] 직원(FRONT/POS/SERVING) 계정은 관리자 화면 > 사용자 탭에서 직접 등록하세요.");
}

async function main() {
  const { ADMINID, ADMINPASSWORD } = process.env;

  if (!ADMINID || !ADMINPASSWORD) {
    throw new Error(".env에 ADMINID / ADMINPASSWORD가 설정되어야 합니다. .env.example을 참고하세요.");
  }

  // 정책 위반을 production 기동 시점이 아니라 시드 시점에 바로 알려준다.
  // (서버는 assertProductionEnv()에서 같은 검사를 다시 한다.)
  const problem = validatePasswordPolicy(ADMINPASSWORD, { username: ADMINID, role: "ADMIN" });
  if (problem) {
    throw new Error(`ADMINPASSWORD: ${problem}`);
  }

  await upsertBootstrapAdmin(ADMINID, ADMINPASSWORD);

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

  const paymentMethodCount = await prisma.paymentMethod.count();
  if (paymentMethodCount === 0) {
    await prisma.paymentMethod.createMany({
      data: [
        { code: "CASH", name: "현금", isCash: true, sortOrder: 0 },
        { code: "CARD", name: "카드", isCash: false, sortOrder: 1 },
        { code: "OTHER", name: "기타", isCash: false, sortOrder: 2 },
      ],
    });
    console.log("[seed] 기본 결제수단 3종 생성 (현금/카드/기타)");
  }

  const settings = await prisma.operationSettings.findUnique({ where: { id: 1 } });
  if (!settings) {
    await prisma.operationSettings.create({ data: { id: 1 } });
    console.log("[seed] 운영 설정 기본값 생성");
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
