import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff, loginAgent, createTableWithMenu, openTableAndJoin } from "./helpers.js";
import { prisma } from "../src/prisma.js";
import { toCsv, neutralizeFormula } from "../src/services/csv.js";

/** 요구사항2.md §5.3 — CSV formula injection 방어. */
describe("CSV formula injection 방어", () => {
  it("수식 트리거 문자로 시작하는 값은 무해한 텍스트가 된다", () => {
    for (const payload of ["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      const neutralized = neutralizeFormula(payload);
      expect(neutralized.startsWith("'")).toBe(true);
      expect(neutralized).toBe(`'${payload}`);
    }
  });

  it("대표적인 명령 실행 페이로드가 수식으로 해석되지 않는다", () => {
    const attack = '=cmd|\' /C calc\'!A0';
    const csv = toCsv(["이름"], [[attack]]);
    // 셀 값이 =로 시작하지 않아야 한다(따옴표로 감싸진 경우 내부 첫 글자까지 확인).
    const cell = csv.split("\r\n")[1];
    expect(cell.replace(/^"/, "").startsWith("=")).toBe(false);
    expect(csv).toContain("'=cmd");
  });

  it("RFC4180 이스케이프는 그대로 유지된다", () => {
    const csv = toCsv(["a", "b"], [['쉼표,포함', '따옴표"포함']]);
    expect(csv).toContain('"쉼표,포함"');
    expect(csv).toContain('"따옴표""포함"');
  });

  it("숫자는 수식 중화 대상이 아니다 — 음수가 문자열로 바뀌지 않는다", () => {
    const csv = toCsv(["금액"], [[-1000]]);
    expect(csv).toContain("-1000");
    expect(csv).not.toContain("'-1000");
  });

  it("감사 로그 CSV로 내보내도 관리자 입력값이 수식으로 나가지 않는다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);
    const marker = `CSV_INJECTION_TEST_${Date.now()}`;
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: marker,
        metadata: '=HYPERLINK("http://evil.example","click")',
        prevHash: "x",
        hash: "y",
        hashVersion: 2,
      },
    });

    const res = await admin.get(`/api/staff/admin/export/audit-logs.csv?action=${marker}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("'=HYPERLINK");
  });
});

/** 요구사항2.md §6.1 / §6.2 / §9.4 — HTTP 하드닝. */
describe("HTTP 하드닝", () => {
  it("민감 API 응답은 캐시되지 않는다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);

    for (const path of ["/api/staff/me", "/api/staff/admin/users", "/api/staff/admin/revenue", "/api/staff/admin/backups"]) {
      const res = await admin.get(path);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("손님 API 응답도 캐시되지 않는다", async () => {
    const { table } = await createTableWithMenu();
    const { username, password } = await createStaff("FRONT");
    const front = await loginAgent(username, password);
    const { customer } = await openTableAndJoin(front, table.id, table.publicSlug);

    for (const path of ["/api/customer/session", "/api/customer/orders", "/api/customer/menu"]) {
      const res = await customer.get(path);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("모든 응답에 추적용 요청 ID가 붙는다", async () => {
    const res = await request(app).get("/api/customer/entry/no-such-slug");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("/healthz는 liveness, /readyz는 DB까지 확인한다", async () => {
    const live = await request(app).get("/healthz");
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ ok: true });

    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true });
    // 헬스 엔드포인트는 버전/경로 같은 내부 정보를 노출하지 않는다.
    expect(Object.keys(ready.body)).toEqual(["ok"]);
  });

  it("200KB를 넘는 요청 본문은 거부된다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);
    const huge = "가".repeat(200_000);
    const res = await admin.post("/api/staff/admin/menu/categories").set("X-BoardBite-Client", "1").send({ name: huge });
    expect([400, 413]).toContain(res.status);
  });

  it("오류 응답에 내부 경로나 Prisma 정보가 새지 않는다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);
    // 존재하지 않는 리소스 → 도메인 오류 메시지만 나와야 한다.
    const res = await admin.get("/api/staff/admin/backups/not-a-real-file.db");
    const raw = JSON.stringify(res.body);
    expect(raw.toLowerCase()).not.toContain("prisma");
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain(".sqlite");
    expect(raw.toLowerCase()).not.toContain("at object.");
  });
});
