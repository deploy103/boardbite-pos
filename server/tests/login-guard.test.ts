import { describe, it, expect } from "vitest";
import request from "supertest";
import { app, createStaff } from "./helpers.js";
import { prisma } from "../src/prisma.js";

const IP_FAIL_THRESHOLD = 15; // server/src/auth/loginGuard.ts와 동일한 값

describe("로그인 brute force 방어", () => {
  it("같은 계정으로 5회 연속 비밀번호 오류 시, 6번째 시도(비밀번호가 맞아도) 429로 차단된다", async () => {
    const { username, password } = await createStaff("FRONT");

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post("/api/staff/login")
        .set("X-BoardBite-Client", "1")
        .send({ username, password: "wrong-password" });
      expect(res.status).toBe(401);
    }

    // 6번째: 이번엔 올바른 비밀번호를 보내도 계정 잠금 때문에 429여야 한다.
    const blockedRes = await request(app)
      .post("/api/staff/login")
      .set("X-BoardBite-Client", "1")
      .send({ username, password });
    expect(blockedRes.status).toBe(429);
  });

  it("로그인 실패 응답에는 비밀번호나 해시가 노출되지 않는다", async () => {
    const { username } = await createStaff("FRONT");
    const res = await request(app)
      .post("/api/staff/login")
      .set("X-BoardBite-Client", "1")
      .send({ username, password: "totally-wrong" });

    expect(res.status).toBe(401);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("totally-wrong");
    expect(raw.toLowerCase()).not.toContain("passwordhash");
    expect(raw.toLowerCase()).not.toContain("$2a$");
    expect(raw.toLowerCase()).not.toContain("$2b$"); // bcrypt 해시 접두사
    expect(Object.keys(res.body)).toEqual(["error"]);
  });

  it("계정 잠금과 별개로 IP 단위 반복 실패 제한이 존재하며, 다른 계정에 대한 반복 실패로도 차단된다", async () => {
    // 이 IP(127.0.0.1, supertest 기본값)의 현재 누적 실패 횟수를 확인하고,
    // 임계값(IP_FAIL_THRESHOLD)에 도달할 때까지 서로 다른 계정으로 실패 로그인을 반복한다.
    // 계정 단위 잠금(5회)에 걸리지 않도록 매번 새 계정을 사용한다.
    const probe = await createStaff("FRONT");
    const probeRes = await request(app)
      .post("/api/staff/login")
      .set("X-BoardBite-Client", "1")
      .send({ username: probe.username, password: "wrong-password" });
    expect(probeRes.status).toBe(401);

    const sample = await prisma.loginAttempt.findFirst({
      where: { username: probe.username, succeeded: false },
      orderBy: { createdAt: "desc" },
    });
    expect(sample).not.toBeNull();
    const ip = sample!.ip;

    let currentFailures = await prisma.loginAttempt.count({ where: { ip, succeeded: false } });
    let guard = 0;
    while (currentFailures < IP_FAIL_THRESHOLD && guard < IP_FAIL_THRESHOLD + 5) {
      const { username } = await createStaff("FRONT");
      const res = await request(app)
        .post("/api/staff/login")
        .set("X-BoardBite-Client", "1")
        .send({ username, password: "wrong-password" });
      // 아직 IP 임계값에 도달하기 전이라면 일반적인 401, 도달한 이후라면 429일 수 있다.
      expect([401, 429]).toContain(res.status);
      currentFailures = await prisma.loginAttempt.count({ where: { ip, succeeded: false } });
      guard += 1;
    }

    expect(currentFailures).toBeGreaterThanOrEqual(IP_FAIL_THRESHOLD);

    // 완전히 새로운(잠기지 않은) 계정으로 올바른 비밀번호를 보내도 IP 제한으로 차단되어야 한다.
    const fresh = await createStaff("FRONT");
    const blockedRes = await request(app)
      .post("/api/staff/login")
      .set("X-BoardBite-Client", "1")
      .send({ username: fresh.username, password: fresh.password });
    expect(blockedRes.status).toBe(429);

    // 이 테스트 파일은 의도적으로 실제 IP 잠금 임계값을 넘겨야 하므로, 검증이 끝나면
    // 이 IP(127.0.0.1, supertest 공용 IP)에 대해 우리가 만든 실패 기록을 정리해서
    // 같은 프로세스/DB를 공유하는 다른 테스트 파일의 로그인이 막히지 않도록 한다.
    await prisma.loginAttempt.deleteMany({ where: { ip } });
  });
});
