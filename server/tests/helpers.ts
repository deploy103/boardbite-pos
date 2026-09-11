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
