import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { generateJoinCode, hashJoinCode } from "../src/services/customerSession.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const prisma = new PrismaClient();

function slug() {
  return randomBytes(16).toString("base64url");
}

async function main() {
  // 데모 테이블 세션을 "연 사람"으로 기록할 계정. FRONT 계정은 환경변수로 시드되지 않고
  // 관리자 화면에서 만들어지므로, 이미 만들어져 있는 계정 중에서 고른다(없으면 ADMIN).
  const front =
    (await prisma.staffUser.findFirst({ where: { role: "FRONT", isActive: true }, orderBy: { createdAt: "asc" } })) ??
    (await prisma.staffUser.findFirst({ where: { role: "ADMIN", isActive: true }, orderBy: { createdAt: "asc" } }));
  if (!front) {
    throw new Error(
      "데모 데이터를 넣으려면 직원 계정이 최소 1개 필요합니다. 먼저 `npm run prisma:seed`로 ADMIN을 만드세요.",
    );
  }

  // ---- 메뉴 ----
  const udon = await prisma.menuCategory.create({ data: { name: "우동", sortOrder: 0 } });
  const drink = await prisma.menuCategory.create({ data: { name: "음료", sortOrder: 1 } });
  const snack = await prisma.menuCategory.create({ data: { name: "간식", sortOrder: 2 } });
  const boardgame = await prisma.menuCategory.create({ data: { name: "보드게임", sortOrder: 3 } });

  const jjajang = await prisma.menuItem.create({
    data: {
      categoryId: udon.id,
      name: "짜장우동",
      description: "쫄깃한 면발에 진한 짜장 소스",
      price: 6000,
      sortOrder: 0,
    },
  });
  await prisma.optionGroup.create({
    data: {
      menuItemId: jjajang.id,
      name: "곱빼기",
      required: false,
      multiSelect: false,
      choices: { create: [{ name: "곱빼기 +500", extraPrice: 500 }, { name: "보통", extraPrice: 0 }] },
    },
  });

  await prisma.menuItem.create({
    data: { categoryId: udon.id, name: "짬뽕우동", description: "얼큰한 국물의 짬뽕우동", price: 6500, sortOrder: 1 },
  });
  await prisma.menuItem.create({
    data: { categoryId: udon.id, name: "튀김우동", description: "바삭한 튀김이 올라간 우동", price: 7000, sortOrder: 2, isSoldOut: true },
  });

  await prisma.menuItem.create({ data: { categoryId: drink.id, name: "콜라", price: 2000, needsCooking: false, sortOrder: 0 } });
  await prisma.menuItem.create({ data: { categoryId: drink.id, name: "사이다", price: 2000, needsCooking: false, sortOrder: 1 } });
  await prisma.menuItem.create({ data: { categoryId: drink.id, name: "아이스티", price: 2500, needsCooking: false, sortOrder: 2 } });

  await prisma.menuItem.create({ data: { categoryId: snack.id, name: "감자튀김", price: 3000, sortOrder: 0 } });
  await prisma.menuItem.create({ data: { categoryId: snack.id, name: "소떡소떡", price: 3500, sortOrder: 1 } });

  await prisma.menuItem.create({
    data: { categoryId: boardgame.id, name: "보드게임 이용료(참고용)", description: "실제 요금은 이용권으로 결제", price: 0, needsCooking: false, showInKitchen: false, sortOrder: 0 },
  });

  // ---- 테이블 ----
  const table1 = await prisma.table.create({ data: { number: 1, publicSlug: slug(), sortOrder: 0 } });
  const table2 = await prisma.table.create({ data: { number: 2, publicSlug: slug(), sortOrder: 1 } });
  const table3 = await prisma.table.create({ data: { number: 3, publicSlug: slug(), sortOrder: 2 } });
  await prisma.table.update({ where: { id: table3.id }, data: { status: "DISABLED" } });

  const plan20 = await prisma.gameTimePlan.findFirstOrThrow({ where: { minutes: 20 } });

  // table2는 이미 손님이 이용 중인 상태로 시작 (주문까지 생성)
  await prisma.table.update({ where: { id: table2.id }, data: { status: "OPEN" } });
  // 하드닝 이후 TableSession에는 `token` 컬럼이 없다 — 접근 권한은 세션마다 새로 발급되는
  // 6자리 입장 코드가 쥐고 있고, DB에는 그 HMAC만 저장된다(요구사항2.md §2.2).
  const demoJoinCode = generateJoinCode();
  const session2 = await prisma.tableSession.create({
    data: { tableId: table2.id, guestCount: 3, openedById: front.id },
  });
  await prisma.tableSession.update({
    where: { id: session2.id },
    data: { joinCodeHash: hashJoinCode(session2.id, demoJoinCode), joinCodeIssuedAt: new Date() },
  });
  await prisma.tableGameUsage.create({
    data: {
      tableSessionId: session2.id,
      planId: plan20.id,
      minutes: plan20.minutes,
      price: plan20.price,
      endsAt: new Date(Date.now() + plan20.minutes * 60_000),
    },
  });
  await prisma.order.create({
    data: {
      tableSessionId: session2.id,
      idempotencyKey: `${session2.id}:demo-order-1`,
      items: {
        create: [
          { menuItemId: jjajang.id, nameSnapshot: "짜장우동", unitPrice: 6000, quantity: 2 },
        ],
      },
    },
  });

  console.log("[demo] table1(빈자리) slug:", table1.publicSlug);
  console.log("[demo] table2(이용중) slug:", table2.publicSlug);
  console.log("[demo] table2 입장 코드:", demoJoinCode, "(평문은 DB에 저장되지 않으므로 여기서만 확인 가능)");
  console.log("[demo] table3(비활성)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
