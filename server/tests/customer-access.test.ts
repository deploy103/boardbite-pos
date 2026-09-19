import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff, loginAgent, createTableWithMenu, openTableAndJoin, joinCustomer } from "./helpers.js";
import { prisma } from "../src/prisma.js";

/**
 * 요구사항2.md §2.2 — NFC/QR 고정 URL 재사용 차단.
 *
 * 핵심 주장: `publicSlug`는 "몇 번 테이블인가"만 알려줄 뿐 접근 권한을 주지 않으며,
 * 권한은 오직 그 세션에서만 유효한 join code를 통해서만 발급된다.
 */
async function frontAgent() {
  const { username, password } = await createStaff("FRONT");
  return loginAgent(username, password);
}

const ORDER_BODY = (menuItemId: string, key: string) => ({
  idempotencyKey: key,
  items: [{ menuItemId, quantity: 1, optionChoiceIds: [] }],
});

describe("손님 입장 (join code)", () => {
  it("저장해 둔 publicSlug만으로는 손님 세션이 발급되지 않는다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const front = await frontAgent();
    await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});

    // 과거에 저장해 둔 링크를 그대로 여는 상황 — 테이블이 열려 있다는 사실만 알 수 있다.
    const stranger = request.agent(app);
    const entry = await stranger.get(`/api/customer/entry/${table.publicSlug}`);
    expect(entry.status).toBe(200);
    expect(entry.body.open).toBe(true);
    expect(entry.body.joined).toBe(false);

    // 권한이 필요한 API는 전부 막힌다(코드 입력이 필요하다는 신호를 함께 준다).
    const menu = await stranger.get("/api/customer/menu");
    expect(menu.status).toBe(403);
    expect(menu.body.code).toBe("JOIN_REQUIRED");
    expect((await stranger.get("/api/customer/session")).status).toBe(403);
    const order = await stranger
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(ORDER_BODY(menuItem.id, "no-join"));
    expect(order.status).toBe(403);
  });

  it("올바른 join code로만 세션이 발급된다", async () => {
    const { table } = await createTableWithMenu();
    const front = await frontAgent();
    const openRes = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    const joinCode: string = openRes.body.joinCode;
    expect(joinCode).toMatch(/^\d{6}$/);

    const wrongCode = String((Number(joinCode) + 1) % 1_000_000).padStart(6, "0");
    const failed = await request(app)
      .post(`/api/customer/join/${table.publicSlug}`)
      .set("X-BoardBite-Client", "1")
      .send({ joinCode: wrongCode });
    expect(failed.status).toBe(401);
    // 코드 존재 여부가 드러나지 않도록 문구는 항상 동일하다.
    expect(Object.keys(failed.body)).toEqual(["error"]);

    const ok = await joinCustomer(table.publicSlug, joinCode);
    expect((await ok.get("/api/customer/session")).status).toBe(200);
  });

  it("평문 join code는 DB에 저장되지 않는다", async () => {
    const { table } = await createTableWithMenu();
    const front = await frontAgent();
    const openRes = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});

    const session = await prisma.tableSession.findUniqueOrThrow({ where: { id: openRes.body.session.id } });
    expect(session.joinCodeHash).not.toBeNull();
    expect(session.joinCodeHash).not.toContain(openRes.body.joinCode);
  });

  it("이전 세션의 join code는 재OPEN 후 사용할 수 없다", async () => {
    const { table } = await createTableWithMenu();
    const front = await frontAgent();

    const firstOpen = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    const oldCode: string = firstOpen.body.joinCode;
    await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});

    const reopen = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    expect(reopen.body.joinCode).not.toBe(oldCode);

    const reused = await request(app)
      .post(`/api/customer/join/${table.publicSlug}`)
      .set("X-BoardBite-Client", "1")
      .send({ joinCode: oldCode });
    expect(reused.status).toBe(401);
  });

  it("CLOSED 테이블에는 어떤 코드로도 입장할 수 없다", async () => {
    const { table } = await createTableWithMenu();
    const front = await frontAgent();
    const openRes = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});

    const res = await request(app)
      .post(`/api/customer/join/${table.publicSlug}`)
      .set("X-BoardBite-Client", "1")
      .send({ joinCode: openRes.body.joinCode });
    expect(res.status).toBe(403);
  });

  it("테이블을 종료하면 이미 입장한 손님 기기도 즉시 무효화된다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const front = await frontAgent();
    const { customer, session } = await openTableAndJoin(front, table.id, table.publicSlug);

    expect((await customer.get("/api/customer/session")).status).toBe(200);

    await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});

    // revokedAt이 실제로 찍혀야 한다(쿠키가 남아 있어도 서버가 거부).
    const devices = await prisma.customerDeviceSession.findMany({ where: { tableSessionId: session.id } });
    expect(devices.length).toBeGreaterThan(0);
    expect(devices.every((d) => d.revokedAt !== null)).toBe(true);

    expect((await customer.get("/api/customer/session")).status).toBe(403);
    const order = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(ORDER_BODY(menuItem.id, "after-close"));
    expect(order.status).toBe(403);
  });

  it("다른 테이블에서 받은 토큰으로는 이 테이블에 접근할 수 없다", async () => {
    const front = await frontAgent();
    const a = await createTableWithMenu();
    const b = await createTableWithMenu();

    const { customer: customerA } = await openTableAndJoin(front, a.table.id, a.table.publicSlug);
    const openB = await front.post(`/api/staff/front/tables/${b.table.id}/open`).set("X-BoardBite-Client", "1").send({});

    // A 테이블 쿠키를 가진 기기가 B 테이블 입구를 열어도 "입장하지 않음"으로 판정된다.
    const entryB = await customerA.get(`/api/customer/entry/${b.table.publicSlug}`);
    expect(entryB.body.open).toBe(true);
    expect(entryB.body.joined).toBe(false);

    // 주문은 여전히 A 세션으로만 들어간다 — B 세션에 섞이지 않는다.
    const order = await customerA
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send(ORDER_BODY(a.menuItem.id, "cross-table"));
    expect(order.status).toBe(201);
    expect(order.body.order.tableSessionId).not.toBe(openB.body.session.id);
  });

  it("join code 무차별 대입은 테이블별로 차단된다", async () => {
    const { table } = await createTableWithMenu();
    const front = await frontAgent();
    await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});

    let blocked = false;
    // 리미터는 (IP, slug) 조합 기준이라 같은 테이블을 계속 두드리면 반드시 걸린다.
    for (let i = 0; i < 20 && !blocked; i += 1) {
      const res = await request(app)
        .post(`/api/customer/join/${table.publicSlug}`)
        .set("X-BoardBite-Client", "1")
        .send({ joinCode: String(i).padStart(6, "0") });
      if (res.status === 429) blocked = true;
    }
    expect(blocked).toBe(true);
  });

  it("FRONT는 코드를 잊었을 때 재발급할 수 있고, 새 코드만 통한다", async () => {
    const { table } = await createTableWithMenu();
    const front = await frontAgent();
    const openRes = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    const oldCode: string = openRes.body.joinCode;

    const rotated = await front
      .post(`/api/staff/front/table-sessions/${openRes.body.session.id}/rotate-join-code`)
      .set("X-BoardBite-Client", "1")
      .send({});
    expect(rotated.status).toBe(200);
    expect(rotated.body.joinCode).not.toBe(oldCode);

    const withOld = await request(app)
      .post(`/api/customer/join/${table.publicSlug}`)
      .set("X-BoardBite-Client", "1")
      .send({ joinCode: oldCode });
    expect(withOld.status).toBe(401);

    const withNew = await joinCustomer(table.publicSlug, rotated.body.joinCode);
    expect((await withNew.get("/api/customer/session")).status).toBe(200);
  });
});
