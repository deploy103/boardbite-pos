import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff, loginAgent, createTableWithMenu, openTableSessionDirect } from "./helpers.js";
import { prisma } from "../src/prisma.js";

async function adminAgent() {
  const { username, password } = await createStaff("ADMIN");
  return loginAgent(username, password);
}

describe("운영 설정 (ADMIN)", () => {
  it("설정을 조회하고 일부 값만 변경할 수 있다", async () => {
    const admin = await adminAgent();
    const before = await admin.get("/api/staff/admin/settings");
    expect(before.status).toBe(200);
    expect(before.body.settings.orderingEnabled).toBe(true);

    const patch = await admin
      .patch("/api/staff/admin/settings")
      .set("X-BoardBite-Client", "1")
      .send({ kdsWarnAfterSeconds: 120, kdsDangerAfterSeconds: 240 });
    expect(patch.status).toBe(200);
    expect(patch.body.settings.kdsWarnAfterSeconds).toBe(120);
    expect(patch.body.settings.kdsDangerAfterSeconds).toBe(240);
    // 다른 필드는 그대로 유지되어야 한다
    expect(patch.body.settings.orderingEnabled).toBe(true);

    // 원복
    await admin.patch("/api/staff/admin/settings").set("X-BoardBite-Client", "1").send({ kdsWarnAfterSeconds: 300, kdsDangerAfterSeconds: 600 });
  });

  it("임박 기준이 지연 기준보다 크거나 같으면 거부된다", async () => {
    const admin = await adminAgent();
    const res = await admin
      .patch("/api/staff/admin/settings")
      .set("X-BoardBite-Client", "1")
      .send({ kdsWarnAfterSeconds: 500, kdsDangerAfterSeconds: 400 });
    expect(res.status).toBe(400);
  });

  it("전체 주문 기능을 끄면 손님이 새 주문을 생성할 수 없다", async () => {
    const admin = await adminAgent();
    const { table, menuItem } = await createTableWithMenu();
    const front = await createStaff("FRONT");
    await openTableSessionDirect(table.id, front.username);

    const customer = request.agent(app);
    await customer.get(`/api/customer/entry/${table.publicSlug}`);

    await admin.patch("/api/staff/admin/settings").set("X-BoardBite-Client", "1").send({ orderingEnabled: false });
    try {
      const res = await customer
        .post("/api/customer/orders")
        .set("X-BoardBite-Client", "1")
        .send({ idempotencyKey: "ordering-off", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
      expect(res.status).toBe(409);
    } finally {
      await admin.patch("/api/staff/admin/settings").set("X-BoardBite-Client", "1").send({ orderingEnabled: true });
    }
  });
});

describe("테이블 잠금 (ADMIN)", () => {
  it("특정 테이블의 주문을 잠그면 그 테이블에서만 주문이 차단된다", async () => {
    const admin = await adminAgent();
    const { table, menuItem } = await createTableWithMenu();
    const front = await createStaff("FRONT");
    await openTableSessionDirect(table.id, front.username);

    const customer = request.agent(app);
    await customer.get(`/api/customer/entry/${table.publicSlug}`);

    const lockRes = await admin.patch(`/api/staff/admin/tables/${table.id}`).set("X-BoardBite-Client", "1").send({ ordersLocked: true });
    expect(lockRes.status).toBe(200);
    expect(lockRes.body.table.ordersLocked).toBe(true);

    const orderRes = await customer
      .post("/api/customer/orders")
      .set("X-BoardBite-Client", "1")
      .send({ idempotencyKey: "table-locked", items: [{ menuItemId: menuItem.id, quantity: 1, optionChoiceIds: [] }] });
    expect(orderRes.status).toBe(409);
  });
});

describe("결제수단 관리 (ADMIN)", () => {
  it("커스텀 결제수단을 추가하고 비활성화할 수 있다", async () => {
    const admin = await adminAgent();
    const code = `TOSS_${Date.now()}`;
    const create = await admin.post("/api/staff/admin/payment-methods").set("X-BoardBite-Client", "1").send({ code, name: "토스페이" });
    expect(create.status).toBe(201);
    expect(create.body.method.isCash).toBe(false);

    const patch = await admin.patch(`/api/staff/admin/payment-methods/${create.body.method.id}`).set("X-BoardBite-Client", "1").send({ isActive: false });
    expect(patch.status).toBe(200);
    expect(patch.body.method.isActive).toBe(false);
  });

  it("소문자나 공백이 포함된 결제수단 코드는 거부된다", async () => {
    const admin = await adminAgent();
    const res = await admin.post("/api/staff/admin/payment-methods").set("X-BoardBite-Client", "1").send({ code: "toss pay", name: "토스페이" });
    expect(res.status).toBe(400);
  });

  it("기본 현금(CASH) 결제수단은 비활성화할 수 없다", async () => {
    const admin = await adminAgent();
    const cash = await prisma.paymentMethod.findUniqueOrThrow({ where: { code: "CASH" } });
    const res = await admin.patch(`/api/staff/admin/payment-methods/${cash.id}`).set("X-BoardBite-Client", "1").send({ isActive: false });
    expect(res.status).toBe(400);
  });

  it("이미 존재하는 코드로 결제수단을 만들 수 없다", async () => {
    const admin = await adminAgent();
    const res = await admin.post("/api/staff/admin/payment-methods").set("X-BoardBite-Client", "1").send({ code: "CASH", name: "현금2" });
    expect(res.status).toBe(409);
  });
});

describe("매출 현황 및 결제 내역 조회 (ADMIN)", () => {
  it("결제 내역을 테이블 번호로 검색할 수 있다", async () => {
    const admin = await adminAgent();
    const res = await admin.get("/api/staff/admin/payments");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.payments)).toBe(true);
  });

  it("매출 현황 요약을 조회할 수 있다", async () => {
    const admin = await adminAgent();
    const res = await admin.get("/api/staff/admin/revenue");
    expect(res.status).toBe(200);
    expect(typeof res.body.summary.totalRevenue).toBe("number");
    expect(Array.isArray(res.body.summary.byMethod)).toBe(true);
    expect(Array.isArray(res.body.summary.menuSales)).toBe(true);
  });

  it("since/until로 매출 조회 구간을 제한할 수 있다", async () => {
    const admin = await adminAgent();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const withinRange = await admin.get(`/api/staff/admin/revenue?until=${encodeURIComponent(future.toISOString())}`);
    expect(withinRange.status).toBe(200);
    const all = await admin.get("/api/staff/admin/revenue");
    expect(withinRange.body.summary.totalRevenue).toBe(all.body.summary.totalRevenue);

    const beforeAnyData = await admin.get(`/api/staff/admin/revenue?until=${encodeURIComponent(past.toISOString())}`);
    expect(beforeAnyData.status).toBe(200);
    expect(beforeAnyData.body.summary.byMethod).toEqual([]);
    expect(beforeAnyData.body.summary.menuSales).toEqual([]);
  });

  it("매출 CSV와 감사로그 CSV를 내보낼 수 있다", async () => {
    const admin = await adminAgent();
    const revenueCsv = await admin.get("/api/staff/admin/export/revenue.csv");
    expect(revenueCsv.status).toBe(200);
    expect(revenueCsv.headers["content-type"]).toContain("text/csv");

    const auditCsv = await admin.get("/api/staff/admin/export/audit-logs.csv");
    expect(auditCsv.status).toBe(200);
    expect(auditCsv.headers["content-type"]).toContain("text/csv");
  });
});

describe("DB 백업 (ADMIN)", () => {
  it("백업을 생성하고 목록에서 확인한 뒤 다운로드할 수 있다", async () => {
    const admin = await adminAgent();
    const create = await admin.post("/api/staff/admin/backups").set("X-BoardBite-Client", "1").send();
    expect(create.status).toBe(201);
    expect(create.body.backup.filename).toMatch(/\.db$/);

    const list = await admin.get("/api/staff/admin/backups");
    const listed = list.body.backups.find((b: { filename: string }) => b.filename === create.body.backup.filename);
    expect(listed).toBeDefined();
    // birthtime이 지원되지 않는 파일시스템(WSL DrvFs 등)에서도 파일명 기반으로 생성시각을 정확히
    // 복원해야 한다 — 1970-01-01(epoch)로 잘못 나오지 않는지 확인한다.
    expect(new Date(listed.createdAt).getFullYear()).toBeGreaterThan(2000);
    expect(Date.now() - new Date(listed.createdAt).getTime()).toBeLessThan(60_000);

    const download = await admin.get(`/api/staff/admin/backups/${create.body.backup.filename}`);
    expect(download.status).toBe(200);
  });

  it("경로 조작이 포함된 파일명은 거부된다", async () => {
    const admin = await adminAgent();
    const res = await admin.get("/api/staff/admin/backups/..%2F..%2Fpackage.json");
    expect(res.status).toBe(404);
  });
});
