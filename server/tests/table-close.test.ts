import { describe, it, expect } from "vitest";
import { createStaff, loginAgent, createBareTable, createTableWithMenu, openTableAndJoin, elevate } from "./helpers.js";
import { prisma } from "../src/prisma.js";
import { openTable } from "../src/services/tableSession.js";

/**
 * 요구사항2.md §3.1(FRONT 강제 종료 제거) / §3.2(상태 머신) / §3.7(동시 OPEN).
 */
async function frontAgent() {
  const { username, password } = await createStaff("FRONT");
  return loginAgent(username, password);
}

async function elevatedAdmin() {
  const { username, password } = await createStaff("ADMIN");
  const agent = await loginAgent(username, password);
  await elevate(agent, password);
  return agent;
}

const ORDER = (menuItemId: string, key: string) => ({
  idempotencyKey: key,
  items: [{ menuItemId, quantity: 1, optionChoiceIds: [] }],
});

describe("FRONT 일반 종료 조건", () => {
  it("미결제 금액이 남아 있으면 종료할 수 없고 구체적인 사유를 돌려준다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const front = await frontAgent();
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);
    await customer.post("/api/customer/orders").set("X-BoardBite-Client", "1").send(ORDER(menuItem.id, "unpaid"));

    const res = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CLOSE_BLOCKED");
    const codes = res.body.blockers.map((b: { code: string }) => b.code);
    expect(codes).toContain("REMAINING_AMOUNT");
    expect(res.body.error).toContain("6,000원");

    // 세션은 그대로 살아 있어야 한다.
    const session = await prisma.tableSession.findFirstOrThrow({ where: { tableId: table.id }, orderBy: { openedAt: "desc" } });
    expect(session.status).toBe("ACTIVE");
  });

  it("서빙되지 않은 주문이 남아 있으면 종료할 수 없다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const front = await frontAgent();
    const { customer, session } = await openTableAndJoin(front, table.id, table.publicSlug);
    await customer.post("/api/customer/orders").set("X-BoardBite-Client", "1").send(ORDER(menuItem.id, "unserved"));

    // 전액 결제해 미수금은 0으로 만들고, 주문은 READY 상태로 남겨둔다.
    await front
      .post(`/api/staff/front/table-sessions/${session.id}/payments`)
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "pay-all", methodCode: "CARD", mode: "AMOUNT", amount: 6000 });

    const res = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b: { code: string }) => b.code)).toContain("UNSERVED_ORDERS");
  });

  it("처리되지 않은 직원 호출이 있으면 종료할 수 없다", async () => {
    const { table } = await createTableWithMenu();
    const front = await frontAgent();
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);
    await customer.post("/api/customer/staff-call").set("X-BoardBite-Client", "1").send();

    const res = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b: { code: string }) => b.code)).toContain("PENDING_STAFF_CALLS");
  });

  it("막는 사유가 없으면 정상적으로 종료된다", async () => {
    const table = await createBareTable();
    const front = await frontAgent();
    await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});

    const preflight = await front.get(`/api/staff/front/tables/${table.id}/close-preflight`);
    expect(preflight.body.canClose).toBe(true);

    const res = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(res.status).toBe(200);
    expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).status).toBe("AVAILABLE");
  });
});

describe("ADMIN 강제 종료", () => {
  it("step-up 없이는 강제 종료할 수 없다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const front = await frontAgent();
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);
    await customer.post("/api/customer/orders").set("X-BoardBite-Client", "1").send(ORDER(menuItem.id, "force-nostep"));

    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);
    const res = await admin
      .post(`/api/staff/admin/tables/${table.id}/force-close`)
      .set("X-BoardBite-Client", "1")
      .send({ reason: "행사 종료" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("STEP_UP_REQUIRED");
  });

  it("사유 없이는 강제 종료할 수 없다", async () => {
    const table = await createBareTable();
    const front = await frontAgent();
    await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    const admin = await elevatedAdmin();

    const res = await admin.post(`/api/staff/admin/tables/${table.id}/force-close`).set("X-BoardBite-Client", "1").send({});
    expect(res.status).toBe(400);
  });

  it("미결제가 남아 있어도 종료되며, 남은 현황이 감사 로그에 기록된다", async () => {
    const { table, menuItem } = await createTableWithMenu();
    const front = await frontAgent();
    const { customer, session } = await openTableAndJoin(front, table.id, table.publicSlug);
    await customer.post("/api/customer/orders").set("X-BoardBite-Client", "1").send(ORDER(menuItem.id, "force-close"));

    const admin = await elevatedAdmin();
    const preview = await admin.get(`/api/staff/admin/tables/${table.id}/force-close-preview`);
    expect(preview.body.blockers.length).toBeGreaterThan(0);

    const res = await admin
      .post(`/api/staff/admin/tables/${table.id}/force-close`)
      .set("X-BoardBite-Client", "1")
      .send({ reason: "손님이 결제 없이 이탈" });
    expect(res.status).toBe(200);

    const closed = await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closeReason).toBe("손님이 결제 없이 이탈");

    // 삭제가 아니라 "기록이 남는 종료"여야 한다.
    const log = await prisma.auditLog.findFirst({
      where: { action: "TABLE_FORCE_CLOSED", targetId: table.id },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    const metadata = JSON.parse(log!.metadata!);
    expect(metadata.force).toBe(true);
    expect(metadata.reason).toBe("손님이 결제 없이 이탈");
    expect(metadata.blockers.some((b: { code: string }) => b.code === "REMAINING_AMOUNT")).toBe(true);

    // 손님 기기도 함께 무효화된다.
    expect((await customer.get("/api/customer/session")).status).toBe(403);
  });
});

describe("테이블 상태 머신", () => {
  it("ADMIN이 PATCH로 status를 직접 바꿀 수 없다", async () => {
    const table = await createBareTable();
    const front = await frontAgent();
    await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});

    const admin = await elevatedAdmin();
    // status는 스키마에서 제거됐으므로 보내도 무시된다(400이든 200이든 상태는 그대로여야 한다).
    await admin.patch(`/api/staff/admin/tables/${table.id}`).set("X-BoardBite-Client", "1").send({ status: "AVAILABLE" });

    const after = await prisma.table.findUniqueOrThrow({ where: { id: table.id } });
    expect(after.status).toBe("OPEN");
  });

  it("사용 중인 테이블은 사용 중지할 수 없다", async () => {
    const table = await createBareTable();
    const front = await frontAgent();
    await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});

    const admin = await elevatedAdmin();
    const res = await admin
      .post(`/api/staff/admin/tables/${table.id}/enabled`)
      .set("X-BoardBite-Client", "1")
      .send({ enabled: false });
    expect(res.status).toBe(409);
    expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).status).toBe("OPEN");
  });

  it("빈 테이블은 사용 중지/재개할 수 있다", async () => {
    const table = await createBareTable();
    const admin = await elevatedAdmin();

    const off = await admin.post(`/api/staff/admin/tables/${table.id}/enabled`).set("X-BoardBite-Client", "1").send({ enabled: false });
    expect(off.body.table.status).toBe("DISABLED");

    const on = await admin.post(`/api/staff/admin/tables/${table.id}/enabled`).set("X-BoardBite-Client", "1").send({ enabled: true });
    expect(on.body.table.status).toBe("AVAILABLE");
  });

  it("Table.status와 TableSession.status는 어긋나지 않는다", async () => {
    const tables = await prisma.table.findMany({ include: { sessions: { where: { status: { in: ["ACTIVE", "PAID_PENDING_SERVICE"] } } } } });
    for (const table of tables) {
      if (table.sessions.length > 0) {
        expect(["OPEN", "SETTLING"]).toContain(table.status);
      } else {
        expect(["AVAILABLE", "DISABLED"]).toContain(table.status);
      }
    }
  });
});

describe("동시 OPEN", () => {
  it("같은 테이블을 동시에 열어도 하나만 성공한다", async () => {
    const table = await createBareTable();
    const { username } = await createStaff("FRONT");
    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { username } });

    const results = await Promise.allSettled([
      openTable({ tableId: table.id, openedById: staff.id }),
      openTable({ tableId: table.id, openedById: staff.id }),
      openTable({ tableId: table.id, openedById: staff.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const sessions = await prisma.tableSession.count({ where: { tableId: table.id, status: "ACTIVE" } });
    expect(sessions).toBe(1);
  });
});
