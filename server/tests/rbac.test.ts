import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff, loginAgent } from "./helpers.js";

describe("RBAC", () => {
  it("/healthz는 로그인 없이도 200을 반환한다 (Docker healthcheck용)", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("로그인하지 않은 요청은 401을 받는다", async () => {
    const res = await request(app).get("/api/staff/admin/users");
    expect(res.status).toBe(401);
  });

  it("POS 계정은 관리자 API를 호출할 수 없다 (403)", async () => {
    const { username, password } = await createStaff("POS");
    const agent = await loginAgent(username, password);
    const res = await agent.get("/api/staff/admin/users");
    expect(res.status).toBe(403);
  });

  it("SERVING 계정은 FRONT API를 호출할 수 없다 (403)", async () => {
    const { username, password } = await createStaff("SERVING");
    const agent = await loginAgent(username, password);
    const res = await agent.get("/api/staff/front/tables");
    expect(res.status).toBe(403);
  });

  it("ADMIN 계정은 FRONT/POS 전용 API도 호출할 수 있다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const agent = await loginAgent(username, password);
    const res = await agent.get("/api/staff/front/tables");
    expect(res.status).toBe(200);
  });

  it("커스텀 헤더 없는 상태변경 요청은 CSRF 방어로 차단된다 (403)", async () => {
    const { username, password } = await createStaff("ADMIN");
    const res = await request(app).post("/api/staff/login").send({ username, password });
    expect(res.status).toBe(403);
  });
});
