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

    // 활성화도 TOTP 1회 소비다(재사용 방어). 그 부수효과가 이어지는 검증을 가리지 않도록
    // 여기서 초기화한다 — 재사용 방어 자체는 아래 전용 테스트가 직접 확인한다.
    await prisma.staffUser.update({ where: { username }, data: { mfaLastUsedCounter: null } });

    return { username, password, secret: setup.body.secret as string };
  }

  /**
   * 같은 30초 슬롯의 코드는 한 번만 통하므로, 한 테스트에서 연속으로 인증해야 할 때는
   * 다음 슬롯(+30초)의 코드를 쓴다. 검증 허용 범위가 ±1스텝이라 이 코드도 정상 통과한다.
   */
  const nextSlotTotp = (secret: string) => generateTotp(secret, Date.now() + 30_000);

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

  /**
   * TOTP는 30초 슬롯마다 같은 6자리가 유효하고 시계 오차 보정으로 앞뒤 1스텝까지 받아주므로,
   * 한 번 노출된 코드가 최대 90초 동안 계속 통한다. 소비한 슬롯을 기록해 재생을 막는다.
   */
  it("한 번 쓴 TOTP 코드는 다시 사용할 수 없다", async () => {
    const { username, password, secret } = await enrollMfa();
    const token = generateTotp(secret);

    const first = request.agent(app);
    await first.post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });
    expect((await first.post("/api/staff/mfa/verify").set("X-BoardBite-Client", "1").send({ token })).status).toBe(200);

    // 같은 코드를 가로챈 공격자가 그대로 재생해도 통하지 않아야 한다.
    const replay = request.agent(app);
    await replay.post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });
    const res = await replay.post("/api/staff/mfa/verify").set("X-BoardBite-Client", "1").send({ token });
    expect(res.status).toBe(401);
    expect((await replay.get("/api/staff/admin/users")).status).toBe(401);
  });

  /**
   * 핵심 방어선: 시도 횟수에 제한이 없으면 5분 pending 창 안에서 6자리를 맞힐 수 있다.
   * 한도를 넘으면 중간 상태를 폐기해 비밀번호부터 다시 받게 한다.
   */
  it("TOTP를 5회 틀리면 pending 상태가 폐기되어 다시 로그인해야 한다", async () => {
    const { username, password, secret } = await enrollMfa();

    const agent = request.agent(app);
    await agent.post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });

    for (let i = 0; i < 5; i += 1) {
      const res = await agent.post("/api/staff/mfa/verify").set("X-BoardBite-Client", "1").send({ token: "000000" });
      expect(res.status).toBe(401);
    }

    // 이제는 올바른 코드를 보내도 pending이 없어 통하지 않는다.
    const correct = await agent
      .post("/api/staff/mfa/verify")
      .set("X-BoardBite-Client", "1")
      .send({ token: generateTotp(secret) });
    expect(correct.status).toBe(401);
    expect((await agent.get("/api/staff/admin/users")).status).toBe(401);

    // 비밀번호부터 다시 시작하면 정상적으로 들어갈 수 있다.
    const retry = request.agent(app);
    await retry.post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });
    const ok = await retry
      .post("/api/staff/mfa/verify")
      .set("X-BoardBite-Client", "1")
      .send({ token: generateTotp(secret) });
    expect(ok.status).toBe(200);
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
      .send({ password, token: nextSlotTotp(secret) });
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

  /** 반복 실패하는 세션은 탈취된 쿠키일 가능성이 높다 — 세션 자체를 끊는다. */
  it("step-up을 5회 실패하면 세션이 끊겨 재로그인해야 한다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const agent = await loginAgent(username, password);
    expect((await agent.get("/api/staff/me")).status).toBe(200);

    for (let i = 0; i < 5; i += 1) {
      const res = await agent.post("/api/staff/step-up").set("X-BoardBite-Client", "1").send({ password: "wrong" });
      expect(res.status).toBe(401);
    }

    // 세션이 폐기되어 인증이 필요한 API 전부가 401이 된다.
    expect((await agent.get("/api/staff/me")).status).toBe(401);
    expect((await agent.get("/api/staff/admin/users")).status).toBe(401);
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
