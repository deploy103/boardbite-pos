import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { hashPassword } from "../src/auth/password.js";
import { generateJoinCode, hashJoinCode } from "../src/services/customerSession.js";
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

/**
 * HTTP 흐름을 거치지 않고 곧바로 ACTIVE TableSession을 만든다(결제 테스트를 단순화).
 * 실제 OPEN과 동일하게 세션 전용 join code까지 발급해 두므로, 필요하면 joinCustomer로 손님 입장을 붙일 수 있다.
 */
export async function openTableSessionDirect(tableId: string, staffUsername?: string) {
  const username = staffUsername ?? (await createStaff("FRONT")).username;
  const staff = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
  await prisma.table.update({ where: { id: tableId }, data: { status: "OPEN" } });
  const created = await prisma.tableSession.create({ data: { tableId, openedById: staff.id } });
  const joinCode = generateJoinCode();
  const session = await prisma.tableSession.update({
    where: { id: created.id },
    data: { joinCodeHash: hashJoinCode(created.id, joinCode), joinCodeIssuedAt: new Date() },
  });
  return Object.assign(session, { joinCode });
}

/**
 * 손님 입장. 저장된 publicSlug만으로는 아무 권한도 생기지 않으므로(요구사항2.md §2.2),
 * 반드시 그 세션의 join code를 제시해야 device session 쿠키를 받는다.
 */
export async function joinCustomer(slug: string, joinCode: string) {
  const customer = request.agent(app);
  const res = await customer
    .post(`/api/customer/join/${slug}`)
    .set("X-BoardBite-Client", "1")
    .send({ joinCode });
  if (res.status !== 200) {
    throw new Error(`손님 입장 실패: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return customer;
}

/** FRONT 로그인 agent로 테이블을 열고, 그 세션에 손님 한 명을 입장시킨다. */
export async function openTableAndJoin(
  front: Awaited<ReturnType<typeof loginAgent>>,
  tableId: string,
  slug: string,
  body: Record<string, unknown> = { guestCount: 2 },
) {
  const openRes = await front.post(`/api/staff/front/tables/${tableId}/open`).set("X-BoardBite-Client", "1").send(body);
  if (openRes.status !== 201) {
    throw new Error(`테이블 OPEN 실패: ${openRes.status} ${JSON.stringify(openRes.body)}`);
  }
  const joinCode: string = openRes.body.joinCode;
  const customer = await joinCustomer(slug, joinCode);
  return { customer, joinCode, session: openRes.body.session };
}

/**
 * 고위험 작업 전 step-up 재인증(요구사항2.md §2.5.2).
 * MFA가 꺼진 계정은 비밀번호만으로 통과한다.
 */
export async function elevate(agent: Awaited<ReturnType<typeof loginAgent>>, password: string) {
  const res = await agent.post("/api/staff/step-up").set("X-BoardBite-Client", "1").send({ password });
  if (res.status !== 200) {
    throw new Error(`step-up 실패: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
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

/** 필수/단일선택 옵션 그룹이 달린 메뉴를 만든다(옵션 규칙 검증 테스트용). */
export async function createMenuItemWithOptions(price = 6000) {
  const category = await prisma.menuCategory.create({ data: { name: unique("optcat") } });
  const menuItem = await prisma.menuItem.create({ data: { categoryId: category.id, name: "옵션메뉴", price } });

  const requiredSingle = await prisma.optionGroup.create({
    data: { menuItemId: menuItem.id, name: "사이즈", required: true, multiSelect: false },
  });
  const optionalMulti = await prisma.optionGroup.create({
    data: { menuItemId: menuItem.id, name: "토핑", required: false, multiSelect: true },
  });

  const small = await prisma.optionChoice.create({ data: { groupId: requiredSingle.id, name: "보통", extraPrice: 0 } });
  const large = await prisma.optionChoice.create({ data: { groupId: requiredSingle.id, name: "곱빼기", extraPrice: 1000 } });
  const cheese = await prisma.optionChoice.create({ data: { groupId: optionalMulti.id, name: "치즈", extraPrice: 500 } });
  const inactive = await prisma.optionChoice.create({
    data: { groupId: optionalMulti.id, name: "품절토핑", extraPrice: 700, isActive: false },
  });

  return { menuItem, requiredSingle, optionalMulti, small, large, cheese, inactive };
}
