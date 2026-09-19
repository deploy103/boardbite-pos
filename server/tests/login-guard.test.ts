import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff } from "./helpers.js";
import { prisma } from "../src/prisma.js";
import { backoffDelayMs, LOGIN_GUARD_THRESHOLDS } from "../src/auth/loginGuard.js";

/**
 * 요구사항2.md §4.1 — 계정 잠금 DoS 완화.
 *
 * app.set("trust proxy", 1)이므로 X-Forwarded-For로 서로 다른 출처 IP를 흉내 낼 수 있다.
 * 이 테스트의 핵심 주장은 "공격자 IP는 막히지만 같은 계정의 정상 로그인은 계속 된다"이다.
 */
function loginFrom(ip: string, username: string, password: string) {
  return request(app)
    .post("/api/staff/login")
    .set("X-BoardBite-Client", "1")
    .set("X-Forwarded-For", ip)
    .send({ username, password });
}

let ipCounter = 0;
/** 테스트끼리 IP 카운터가 섞이지 않도록 매번 새로운 대역을 쓴다. */
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

describe("로그인 brute force 방어", () => {
  it("공격자 IP는 (계정+IP) 임계값에서 차단되지만, 같은 계정은 다른 IP에서 정상 로그인된다", async () => {
    const { username, password } = await createStaff("FRONT");
    const attackerIp = freshIp();
    const staffIp = freshIp();

    for (let i = 0; i < LOGIN_GUARD_THRESHOLDS.PAIR_FAIL_THRESHOLD; i += 1) {
      const res = await loginFrom(attackerIp, username, "wrong-password");
      expect([401, 429]).toContain(res.status);
    }

    // 공격자 IP는 올바른 비밀번호를 보내도 막힌다.
    const blocked = await loginFrom(attackerIp, username, password);
    expect(blocked.status).toBe(429);

    // 하지만 운영진이 쓰는 다른 단말/IP에서는 같은 계정으로 계속 로그인할 수 있어야 한다.
    // (이전 정책의 "username 5회 실패 → 전면 하드 락" DoS가 제거되었다는 뜻이다.)
    const allowed = await loginFrom(staffIp, username, password);
    expect(allowed.status).toBe(200);
  });

  it("한 IP가 여러 계정을 훑으면 IP 단위 임계값에서 차단된다", async () => {
    const scannerIp = freshIp();

    for (let i = 0; i < LOGIN_GUARD_THRESHOLDS.IP_FAIL_THRESHOLD; i += 1) {
      const victim = await createStaff("FRONT");
      const res = await loginFrom(scannerIp, victim.username, "wrong-password");
      expect([401, 429]).toContain(res.status);
    }

    // 이 IP에서는 한 번도 시도하지 않은 새 계정의 올바른 비밀번호조차 통과하지 못한다.
    const fresh = await createStaff("FRONT");
    const blocked = await loginFrom(scannerIp, fresh.username, fresh.password);
    expect(blocked.status).toBe(429);

    // 같은 계정을 다른 IP에서 쓰는 것은 여전히 가능하다.
    const allowed = await loginFrom(freshIp(), fresh.username, fresh.password);
    expect(allowed.status).toBe(200);

    await prisma.loginAttempt.deleteMany({ where: { ip: scannerIp } });
  });

  it("로그인 성공 시 그 (계정, IP)의 실패 기록이 초기화되어 backoff가 풀린다", async () => {
    const { username, password } = await createStaff("FRONT");
    const ip = freshIp();

    await loginFrom(ip, username, "wrong-password");
    await loginFrom(ip, username, "wrong-password");
    expect(await prisma.loginAttempt.count({ where: { username, ip, succeeded: false } })).toBe(2);

    const ok = await loginFrom(ip, username, password);
    expect(ok.status).toBe(200);
    expect(await prisma.loginAttempt.count({ where: { username, ip, succeeded: false } })).toBe(0);
  });

  it("실패가 쌓이면 지수 backoff가 적용되지만 상한이 있다", () => {
    expect(backoffDelayMs(1)).toBe(0);
    expect(backoffDelayMs(2)).toBe(0);
    expect(backoffDelayMs(3)).toBeGreaterThan(0);
    expect(backoffDelayMs(4)).toBeGreaterThan(backoffDelayMs(3));
    expect(backoffDelayMs(50)).toBeLessThanOrEqual(4000);
  });

  it("로그인 실패 응답에는 비밀번호나 해시가 노출되지 않고 계정 존재 여부도 드러나지 않는다", async () => {
    const { username } = await createStaff("FRONT");
    const ip = freshIp();

    const wrongPassword = await loginFrom(ip, username, "totally-wrong");
    const unknownUser = await loginFrom(ip, "no-such-user-at-all", "totally-wrong");

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    // 존재하는 계정과 존재하지 않는 계정의 응답이 완전히 동일해야 한다.
    expect(wrongPassword.body).toEqual(unknownUser.body);

    const raw = JSON.stringify(wrongPassword.body);
    expect(raw).not.toContain("totally-wrong");
    expect(raw.toLowerCase()).not.toContain("passwordhash");
    expect(raw.toLowerCase()).not.toContain("$2a$");
    expect(raw.toLowerCase()).not.toContain("$2b$");
    expect(Object.keys(wrongPassword.body)).toEqual(["error"]);
  });
});
