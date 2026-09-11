import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { hashPassword } from "../src/auth/password.js";
import type { StaffRole } from "../src/types/domain.js";

export const app = createApp();

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

export async function createStaff(role: StaffRole, password = "testpass1234") {
  const username = unique(role.toLowerCase());
  await prisma.staffUser.create({
    data: { username, passwordHash: await hashPassword(password), displayName: username, role },
  });
  return { username, password };
}

export async function loginAgent(username: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/staff/login")
    .set("X-BoardBite-Client", "1")
    .send({ username, password });
  if (res.status !== 200) {
    throw new Error(`로그인 실패: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

export async function createTableWithMenu() {
  const table = await prisma.table.create({
    data: { number: Math.floor(Math.random() * 1_000_000) + 1, publicSlug: unique("slug") },
  });
  const category = await prisma.menuCategory.create({ data: { name: unique("category") } });
  const menuItem = await prisma.menuItem.create({
    data: { categoryId: category.id, name: "테스트메뉴", price: 6000 },
  });
  return { table, category, menuItem };
}

// ---- 아래는 Phase 3(주방/KDS)와 무관한 테스트(로그인 방어, 정산, 테이블 세션, 관리자 API)를 위해 추가된 헬퍼 ----

export async function getStaffIdByUsername(username: string): Promise<string> {
  const user = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
  return user.id;
}

export async function createGameTimePlan(minutes: number, price = 1000) {
  return prisma.gameTimePlan.create({
    data: { name: unique(`plan_${minutes}m`), minutes, price },
  });
}

export async function createBareTable() {
  return prisma.table.create({
    data: { number: Math.floor(Math.random() * 1_000_000) + 1, publicSlug: unique("slug") },
  });
}

// ---- 아래는 Phase 5(결제/정산) 테스트를 위해 추가된 헬퍼 ----

/** HTTP 흐름을 거치지 않고 곧바로 ACTIVE TableSession을 만든다(결제 테스트를 단순화). */
export async function openTableSessionDirect(tableId: string, staffUsername?: string) {
  const username = staffUsername ?? (await createStaff("FRONT")).username;
  const staff = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
  await prisma.table.update({ where: { id: tableId }, data: { status: "OPEN" } });
  return prisma.tableSession.create({
    data: { tableId, token: unique("token"), openedById: staff.id },
  });
}

/** 특정 세션에 주문 항목 1개짜리 주문을 직접 생성한다(결제 대상 orderItem을 얻기 위함). */
export async function createOrderWithItem(
  tableSessionId: string,
  menuItemId: string,
  unitPrice: number,
  quantity: number,
  status = "NEW",
) {
  const order = await prisma.order.create({
    data: {
      tableSessionId,
      status,
      idempotencyKey: unique(`order_${tableSessionId}`),
      items: {
        create: [{ menuItemId, nameSnapshot: "결제테스트메뉴", unitPrice, quantity }],
      },
    },
    include: { items: true },
  });
  return { order, orderItem: order.items[0] };
}
