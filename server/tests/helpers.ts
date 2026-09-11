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
