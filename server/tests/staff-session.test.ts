import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff, loginAgent, elevate } from "./helpers.js";
import { prisma } from "../src/prisma.js";
import { generateTotp } from "../src/auth/totp.js";
import { openSecret } from "../src/auth/secretBox.js";
import { STEP_UP_WINDOW_MS } from "../src/middleware/requireRole.js";

/**
 * 요구사항2.md §2.3~§2.5 — 세션 무효화 / mustResetPassword 강제 / MFA / step-up.
 *
 * 공통 주장: 인가 판단의 기준은 언제나 "지금 이 순간의 DB"다. 로그인 시점에 세션에 담아둔
 * role이나 권한 정보는 어떤 경우에도 최종 근거가 되지 않는다.
 */
async function adminWithStepUp() {
  const { username, password } = await createStaff("ADMIN");
  const agent = await loginAgent(username, password);
  await elevate(agent, password);
  return { agent, username, password };
}

describe("세션 즉시 무효화 (authVersion)", () => {
  it("ADMIN → POS로 역할이 바뀌면 기존 ADMIN 세션은 그 즉시 관리자 API를 쓸 수 없다", async () => {
    const victim = await createStaff("ADMIN");
    const victimAgent = await loginAgent(victim.username, victim.password);
    expect((await victimAgent.get("/api/staff/admin/users")).status).toBe(200);

    const { agent: actor } = await adminWithStepUp();
    const target = await prisma.staffUser.findUniqueOrThrow({ where: { username: victim.username } });
    const patch = await actor
      .patch(`/api/staff/admin/users/${target.id}`)
      .set("X-BoardBite-Client", "1")
      .send({ role: "POS" });
    expect(patch.status).toBe(200);

    // 세션 쿠키는 그대로지만 authVersion이 달라졌으므로 재로그인 전까지 아무것도 할 수 없다.
    expect((await victimAgent.get("/api/staff/admin/users")).status).toBe(401);
    expect((await victimAgent.get("/api/staff/me")).status).toBe(401);
  });

  it("계정을 비활성화하면 기존 세션이 즉시 끊긴다", async () => {
    const victim = await createStaff("FRONT");
    const victimAgent = await loginAgent(victim.username, victim.password);
    expect((await victimAgent.get("/api/staff/front/tables")).status).toBe(200);

    const { agent: actor } = await adminWithStepUp();
    const target = await prisma.staffUser.findUniqueOrThrow({ where: { username: victim.username } });
    await actor.patch(`/api/staff/admin/users/${target.id}`).set("X-BoardBite-Client", "1").send({ isActive: false });

    expect((await victimAgent.get("/api/staff/front/tables")).status).toBe(401);
  });

  it("ADMIN이 비밀번호를 초기화하면 기존 세션이 끊기고 비밀번호 변경이 강제된다", async () => {
    const victim = await createStaff("FRONT");
    const victimAgent = await loginAgent(victim.username, victim.password);

    const { agent: actor } = await adminWithStepUp();
    const target = await prisma.staffUser.findUniqueOrThrow({ where: { username: victim.username } });
    const reset = await actor
      .post(`/api/staff/admin/users/${target.id}/reset-password`)
      .set("X-BoardBite-Client", "1")
      .send({ newPassword: "temporary-pass-1234" });
    expect(reset.status).toBe(200);

    expect((await victimAgent.get("/api/staff/front/tables")).status).toBe(401);

    // 새 임시 비밀번호로 로그인은 되지만 업무 화면으로는 갈 수 없다.
    const relogin = await loginAgent(victim.username, "temporary-pass-1234");
    const me = await relogin.get("/api/staff/me");
    expect(me.body.mustResetPassword).toBe(true);
    const blocked = await relogin.get("/api/staff/front/tables");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_RESET_REQUIRED");
  });

  it("본인이 비밀번호를 바꾸면 다른 기기의 세션이 끊기고, 바꾼 기기는 그대로 쓸 수 있다", async () => {
    const { username, password } = await createStaff("FRONT");
    const deviceA = await loginAgent(username, password);
    const deviceB = await loginAgent(username, password);

    const changed = await deviceA
      .post("/api/staff/change-password")
      .set("X-BoardBite-Client", "1")
      .send({ currentPassword: password, newPassword: "brand-new-password-9876" });
    expect(changed.status).toBe(200);

    // 변경한 기기는 서버가 세션을 재발급해 주므로 계속 사용 가능하다.
    expect((await deviceA.get("/api/staff/front/tables")).status).toBe(200);
    // 다른 기기는 즉시 로그아웃된다.
    expect((await deviceB.get("/api/staff/front/tables")).status).toBe(401);
  });

  it("정상 사용자는 아무 영향을 받지 않는다", async () => {
    const { username, password } = await createStaff("FRONT");
    const agent = await loginAgent(username, password);

    // 다른 계정에 어떤 변경이 일어나도 이 세션은 유지되어야 한다.
    const other = await createStaff("FRONT");
    const { agent: actor } = await adminWithStepUp();
    const target = await prisma.staffUser.findUniqueOrThrow({ where: { username: other.username } });
    await actor.patch(`/api/staff/admin/users/${target.id}`).set("X-BoardBite-Client", "1").send({ isActive: false });

    expect((await agent.get("/api/staff/front/tables")).status).toBe(200);
  });
});

describe("mustResetPassword 강제", () => {
  it("허용된 최소 API만 열려 있고 나머지는 403으로 막힌다", async () => {
    const { username, password } = await createStaff("POS");
    const user = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
    await prisma.staffUser.update({ where: { id: user.id }, data: { mustResetPassword: true } });

    const agent = await loginAgent(username, password);

    // 허용: 내 정보 조회 / 비밀번호 변경 / 로그아웃
    expect((await agent.get("/api/staff/me")).status).toBe(200);
    // 차단: 일반 업무 API
    expect((await agent.get("/api/staff/pos/board")).status).toBe(403);
    expect((await agent.get("/api/staff/settings")).status).toBe(403);

    const changed = await agent
      .post("/api/staff/change-password")
      .set("X-BoardBite-Client", "1")
      .send({ currentPassword: password, newPassword: "fresh-password-abcdef" });
    expect(changed.status).toBe(200);

    // 변경 후에는 정상 업무 가능
    expect((await agent.get("/api/staff/pos/board")).status).toBe(200);
  });

  it("현재 비밀번호가 틀리면 변경되지 않는다", async () => {
    const { username, password } = await createStaff("FRONT");
    const agent = await loginAgent(username, password);
    const res = await agent
      .post("/api/staff/change-password")
      .set("X-BoardBite-Client", "1")
      .send({ currentPassword: "not-the-password", newPassword: "another-good-password" });
    expect(res.status).toBe(400);
  });

  it("이전과 같은 비밀번호로는 바꿀 수 없다", async () => {
    const { username, password } = await createStaff("FRONT");
    const agent = await loginAgent(username, password);
    const res = await agent
      .post("/api/staff/change-password")
      .set("X-BoardBite-Client", "1")
      .send({ currentPassword: password, newPassword: password });
    expect(res.status).toBe(400);
  });
});

describe("TOTP MFA", () => {
  /** 설정 API를 실제로 호출해 MFA를 켠 ADMIN 계정을 만든다. */
  async function enrollMfa() {
    const { username, password } = await createStaff("ADMIN");
    const agent = await loginAgent(username, password);

    const setup = await agent.post("/api/staff/mfa/setup").set("X-BoardBite-Client", "1").send({ currentPassword: password });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toContain("otpauth://totp/");

    const enable = await agent
      .post("/api/staff/mfa/enable")
      .set("X-BoardBite-Client", "1")
      .send({ token: generateTotp(setup.body.secret) });
    expect(enable.status).toBe(200);

    return { username, password, secret: setup.body.secret as string };
  }

  it("secret은 평문으로 저장되지 않는다", async () => {
    const { username, secret } = await enrollMfa();
    const user = await prisma.staffUser.findUniqueOrThrow({ where: { username } });
    expect(user.mfaEnabled).toBe(true);
    expect(user.mfaSecretEncrypted).not.toBeNull();
    expect(user.mfaSecretEncrypted).not.toContain(secret);
    // 서버 키로는 정상적으로 복호화된다.
    expect(openSecret(user.mfaSecretEncrypted!)).toBe(secret);
  });

  it("MFA가 켜진 계정은 ID/PW만으로 권한 세션을 얻지 못한다", async () => {
    const { username, password } = await enrollMfa();

    const agent = request.agent(app);
    const login = await agent.post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.role).toBeUndefined();

    // 아직 세션이 없으므로 관리자 API는 물론 /me도 열리지 않는다.
    expect((await agent.get("/api/staff/admin/users")).status).toBe(401);
  });

  it("틀린 TOTP는 거부되고, 맞는 TOTP로만 세션이 만들어진다", async () => {
    const { username, password, secret } = await enrollMfa();

    const agent = request.agent(app);
    await agent.post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });

    const wrong = await agent.post("/api/staff/mfa/verify").set("X-BoardBite-Client", "1").send({ token: "000000" });
    expect([400, 401]).toContain(wrong.status);
    expect((await agent.get("/api/staff/admin/users")).status).toBe(401);

    const ok = await agent
      .post("/api/staff/mfa/verify")
      .set("X-BoardBite-Client", "1")
      .send({ token: generateTotp(secret) });
    expect(ok.status).toBe(200);
    expect((await agent.get("/api/staff/admin/users")).status).toBe(200);
  });

  it("MFA 계정의 step-up은 비밀번호만으로는 통과하지 못한다", async () => {
    const { username, password, secret } = await enrollMfa();
    const agent = request.agent(app);
    await agent.post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });
    await agent.post("/api/staff/mfa/verify").set("X-BoardBite-Client", "1").send({ token: generateTotp(secret) });

    const passwordOnly = await agent.post("/api/staff/step-up").set("X-BoardBite-Client", "1").send({ password });
    expect(passwordOnly.status).toBe(401);

    const withTotp = await agent
      .post("/api/staff/step-up")
      .set("X-BoardBite-Client", "1")
      .send({ password, token: generateTotp(secret) });
    expect(withTotp.status).toBe(200);
  });
});

describe("step-up 재인증", () => {
  it("틀린 비밀번호로는 승격되지 않는다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const agent = await loginAgent(username, password);
    const res = await agent.post("/api/staff/step-up").set("X-BoardBite-Client", "1").send({ password: "wrong" });
    expect(res.status).toBe(401);
    expect((await agent.get("/api/staff/me")).body.elevated).toBe(false);
  });

  it("승격 후 5분이 지나면 자동으로 만료된다", async () => {
    const { agent } = await adminWithStepUp();
    expect((await agent.get("/api/staff/me")).body.elevated).toBe(true);

    // 세션 레코드의 elevatedUntil을 과거로 돌려 시간 경과를 재현한다(대기 없이 동일한 조건).
    const sessions = await prisma.staffSession.findMany();
    const expired = Date.now() - STEP_UP_WINDOW_MS - 1000;
    for (const row of sessions) {
      const data = JSON.parse(row.data);
      if (typeof data.elevatedUntil !== "number") continue;
      data.elevatedUntil = expired;
      await prisma.staffSession.update({ where: { sid: row.sid }, data: { data: JSON.stringify(data) } });
    }

    expect((await agent.get("/api/staff/me")).body.elevated).toBe(false);
    const blocked = await agent
      .patch("/api/staff/admin/users/whatever")
      .set("X-BoardBite-Client", "1")
      .send({ displayName: "x" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("STEP_UP_REQUIRED");
  });

  it("마지막 관리자 계정은 비활성화하거나 역할을 낮출 수 없다", async () => {
    // 다른 활성 ADMIN이 없도록 이 테스트 전용으로 모든 ADMIN을 잠시 비운 뒤 하나만 만든다.
    const others = await prisma.staffUser.findMany({ where: { role: "ADMIN", isActive: true } });
    await prisma.staffUser.updateMany({ where: { id: { in: others.map((u) => u.id) } }, data: { isActive: false } });

    const { username, password } = await createStaff("ADMIN");
    const agent = await loginAgent(username, password);
    await elevate(agent, password);
    const self = await prisma.staffUser.findUniqueOrThrow({ where: { username } });

    const disable = await agent.patch(`/api/staff/admin/users/${self.id}`).set("X-BoardBite-Client", "1").send({ isActive: false });
    expect(disable.status).toBe(409);

    const demote = await agent.patch(`/api/staff/admin/users/${self.id}`).set("X-BoardBite-Client", "1").send({ role: "POS" });
    expect(demote.status).toBe(409);

    await prisma.staffUser.updateMany({ where: { id: { in: others.map((u) => u.id) } }, data: { isActive: true } });
  });
});
