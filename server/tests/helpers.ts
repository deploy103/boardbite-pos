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
    data: { menuItemId: menuItem.id, name: "사이즈", minSelect: 1, maxSelect: 1 },
  });
  const optionalMulti = await prisma.optionGroup.create({
    data: { menuItemId: menuItem.id, name: "토핑", minSelect: 0, maxSelect: null },
  });

  const small = await prisma.optionChoice.create({ data: { groupId: requiredSingle.id, name: "보통", extraPrice: 0 } });
  const large = await prisma.optionChoice.create({ data: { groupId: requiredSingle.id, name: "곱빼기", extraPrice: 1000 } });
  const cheese = await prisma.optionChoice.create({ data: { groupId: optionalMulti.id, name: "치즈", extraPrice: 500 } });
  const inactive = await prisma.optionChoice.create({
    data: { groupId: optionalMulti.id, name: "품절토핑", extraPrice: 700, isActive: false },
  });

  return { menuItem, requiredSingle, optionalMulti, small, large, cheese, inactive };
}

// ---- 아래는 FRONT 현장 결제 / 쿠폰 / 메뉴 수명주기 테스트를 위해 추가된 헬퍼 ----

export const CLIENT_HEADER = ["X-BoardBite-Client", "1"] as const;

/** 채널/제공 방식을 지정한 메뉴를 만든다. 옵션 없이 바로 팔 수 있는 단순 상품. */
export async function createMenuItem(options: {
  name?: string;
  price: number;
  channel?: "TABLE" | "FRONT" | "BOTH";
  /** 둘 다 false면 "현장 즉시 제공" 상품이 된다(룰렛/보드게임 등). */
  needsCooking?: boolean;
  showInKitchen?: boolean;
  categoryId?: string;
}) {
  const categoryId =
    options.categoryId ?? (await prisma.menuCategory.create({ data: { name: unique("cat") } })).id;
  return prisma.menuItem.create({
    data: {
      categoryId,
      name: options.name ?? unique("menu"),
      price: options.price,
      channel: options.channel ?? "BOTH",
      needsCooking: options.needsCooking ?? true,
      showInKitchen: options.showInKitchen ?? true,
    },
  });
}

/** 현장 즉시 제공 상품(조리 없음, KDS 미표시). 룰렛/보드게임/닌텐도가 여기에 해당한다. */
export function createCounterOnlyItem(name: string, price: number, categoryId?: string) {
  return createMenuItem({ name, price, channel: "FRONT", needsCooking: false, showInKitchen: false, categoryId });
}

/** ADMIN 계정을 만들고 로그인한 agent를 돌려준다(쿠폰 발급/거래 취소 테스트용). */
export async function loginAdmin() {
  const { username, password } = await createStaff("ADMIN", "admin-test-pw-12345678");
  const agent = await loginAgent(username, password);
  return { agent, username, password };
}

export async function loginFront() {
  const { username, password } = await createStaff("FRONT");
  const agent = await loginAgent(username, password);
  return { agent, username, password };
}

/** ADMIN API로 쿠폰 배치를 발급하고 발급된 번호 목록을 돌려준다. */
export async function issueCoupons(
  admin: Awaited<ReturnType<typeof loginAgent>>,
  body: Record<string, unknown>,
): Promise<{ status: number; codes: string[]; body: Record<string, unknown> }> {
  const res = await admin
    .post("/api/staff/admin/coupons/batches")
    .set("X-BoardBite-Client", "1")
    .send({ idempotencyKey: unique("batch"), ...body });
  return { status: res.status, codes: res.body?.batch?.codes ?? [], body: res.body };
}

/** FRONT 현장 결제 확정 한 번. 기본은 현금 정확 수납이다. */
export async function confirmCounterSale(
  front: Awaited<ReturnType<typeof loginAgent>>,
  body: Record<string, unknown>,
) {
  return front
    .post("/api/staff/front/counter/confirm")
    .set("X-BoardBite-Client", "1")
    .send({ idempotencyKey: unique("counter"), ...body });
}

/**
 * 테이블 세션을 "실제 종료와 같은 상태"로 닫는다.
 *
 * 세션만 CLOSED로 바꾸고 Table.status를 그대로 두면 table-close.test.ts의 전역 불변식
 * ("활성 세션이 없는 테이블은 AVAILABLE/DISABLED")이 깨진다. vitest는 파일 실행 순서를 보장하지
 * 않으므로 그 위반은 실행마다 나타났다 사라졌다 하는 간헐 실패로 나타난다 —
 * 테스트에서 세션을 직접 닫아야 할 때는 반드시 이 헬퍼를 쓴다.
 */
export async function closeTableSessionDirect(tableSessionId: string) {
  const session = await prisma.tableSession.findUniqueOrThrow({ where: { id: tableSessionId } });
  await prisma.$transaction([
    prisma.tableSession.update({
      where: { id: tableSessionId },
      data: { status: "CLOSED", closedAt: new Date(), closeReason: "TEST" },
    }),
    prisma.table.update({ where: { id: session.tableId }, data: { status: "AVAILABLE" } }),
  ]);
}
