import { describe, it, expect } from "vitest";
import { extendGameTime, openTable, closeTable, TableSessionError } from "../src/services/tableSession.js";
import { prisma } from "../src/prisma.js";
import { createStaff, loginAgent, createBareTable, createGameTimePlan, getStaffIdByUsername } from "./helpers.js";

describe("테이블 OPEN/CLOSE 엣지 케이스 (HTTP API)", () => {
  it("이미 OPEN 상태인 테이블을 다시 열려고 하면 409로 실패한다", async () => {
    const table = await createBareTable();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);

    const firstOpen = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    expect(firstOpen.status).toBe(201);

    const secondOpen = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    expect(secondOpen.status).toBe(409);
  });

  it("한 번도 열리지 않은(AVAILABLE) 테이블을 닫으려고 하면 실패한다", async () => {
    const table = await createBareTable();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);

    const closeRes = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(closeRes.status).toBe(409);
  });

  it("이미 CLOSED된 테이블을 다시 닫으려고 하면 실패한다", async () => {
    const table = await createBareTable();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);

    const openRes = await front.post(`/api/staff/front/tables/${table.id}/open`).set("X-BoardBite-Client", "1").send({});
    expect(openRes.status).toBe(201);
    const firstClose = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(firstClose.status).toBe(200);

    const secondClose = await front.post(`/api/staff/front/tables/${table.id}/close`).set("X-BoardBite-Client", "1").send({});
    expect(secondClose.status).toBe(409);
  });

  it("존재하지 않는 tableId로 OPEN 시도 시 404를 반환한다", async () => {
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const res = await front.post("/api/staff/front/tables/nonexistent-table-id/open").set("X-BoardBite-Client", "1").send({});
    expect(res.status).toBe(404);
  });

  it("존재하지 않는 tableId로 CLOSE 시도 시 404를 반환한다", async () => {
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const res = await front.post("/api/staff/front/tables/nonexistent-table-id/close").set("X-BoardBite-Client", "1").send({});
    expect(res.status).toBe(404);
  });
});

describe("테이블 OPEN/CLOSE 엣지 케이스 (서비스 함수 직접 호출)", () => {
  it("openTable/closeTable을 직접 호출해도 동일하게 상태 위반을 차단한다", async () => {
    const table = await createBareTable();
    const { username } = await createStaff("FRONT");
    const staffId = await getStaffIdByUsername(username);

    await expect(openTable({ tableId: "no-such-id", openedById: staffId })).rejects.toBeInstanceOf(TableSessionError);
    await expect(closeTable({ tableId: "no-such-id", closedById: staffId })).rejects.toBeInstanceOf(TableSessionError);

    await openTable({ tableId: table.id, openedById: staffId });
    await expect(openTable({ tableId: table.id, openedById: staffId })).rejects.toBeInstanceOf(TableSessionError);

    await closeTable({ tableId: table.id, closedById: staffId });
    await expect(closeTable({ tableId: table.id, closedById: staffId })).rejects.toBeInstanceOf(TableSessionError);
  });
});

describe("이용권(GameTimePlan) 연장 누적 계산", () => {
  it("20분 플랜으로 열고 20분 플랜으로 한 번 더 연장하면 최초 종료시각 기준으로 정확히 40분 뒤가 된다", async () => {
    const table = await createBareTable();
    const { username } = await createStaff("FRONT");
    const staffId = await getStaffIdByUsername(username);
    const plan20 = await createGameTimePlan(20, 1000);

    const { session } = await openTable({ tableId: table.id, openedById: staffId, gameTimePlanId: plan20.id });

    const firstUsage = await prisma.tableGameUsage.findFirstOrThrow({ where: { tableSessionId: session.id } });

    const extended = await extendGameTime({ tableSessionId: session.id, planId: plan20.id, staffId });

    const expectedEndsAt = firstUsage.endsAt.getTime() + 20 * 60_000;
    expect(extended.endsAt.getTime()).toBe(expectedEndsAt);
    expect(extended.endsAt.getTime() - firstUsage.startedAt.getTime()).toBeGreaterThanOrEqual(40 * 60_000 - 1000);
  });

  it("진행 중이 아닌(CLOSED) 세션은 연장할 수 없다", async () => {
    const table = await createBareTable();
    const { username } = await createStaff("FRONT");
    const staffId = await getStaffIdByUsername(username);
    const plan10 = await createGameTimePlan(10, 500);

    const { session } = await openTable({ tableId: table.id, openedById: staffId, gameTimePlanId: plan10.id });
    await closeTable({ tableId: table.id, closedById: staffId });

    await expect(extendGameTime({ tableSessionId: session.id, planId: plan10.id, staffId })).rejects.toBeInstanceOf(
      TableSessionError,
    );
  });
});
