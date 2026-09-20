import { describe, it, expect } from "vitest";
import { createStaff, loginAgent, createTableWithMenu, elevate } from "./helpers.js";
import { prisma } from "../src/prisma.js";

async function loginAsAdmin() {
  const { username, password } = await createStaff("ADMIN");
  return loginAgent(username, password);
}

describe("관리자 API 입력 검증 및 감사 로그", () => {
  it("10자 미만 비밀번호로 직원 계정 생성 시도 시 400을 반환한다", async () => {
    const admin = await loginAsAdmin();
    const res = await admin
      .post("/api/staff/admin/users")
      .set("X-BoardBite-Client", "1")
      .send({ username: `short_${Date.now()}`, password: "short1", displayName: "짧은비번", role: "FRONT" });
    expect(res.status).toBe(400);
  });

  /**
   * 비밀번호 최소 길이는 만들려는 역할이 정한다 — 일반 직원 10자, ADMIN 15자.
   * 같은 비밀번호가 FRONT에서는 통과하고 ADMIN에서는 거부되어야 한다.
   */
  it("직원은 10자면 통과하지만 같은 비밀번호로 ADMIN 계정은 만들 수 없다", async () => {
    const { username: adminName, password: adminPw } = await createStaff("ADMIN");
    const admin = await elevate(await loginAgent(adminName, adminPw), adminPw);

    const twelveChars = "staffpw12345"; // 12자 — 직원 기준(10자)은 넘고 ADMIN 기준(15자)에는 못 미친다
    expect(twelveChars.length).toBeGreaterThanOrEqual(10);
    expect(twelveChars.length).toBeLessThan(15);

    const staffRes = await admin
      .post("/api/staff/admin/users")
      .set("X-BoardBite-Client", "1")
      .send({ username: `staff_${Date.now()}`, password: twelveChars, displayName: "직원", role: "FRONT" });
    expect(staffRes.status).toBe(201);

    const adminRes = await admin
      .post("/api/staff/admin/users")
      .set("X-BoardBite-Client", "1")
      .send({ username: `admin_${Date.now()}`, password: twelveChars, displayName: "관리자", role: "ADMIN" });
    expect(adminRes.status).toBe(400);
    expect(adminRes.body.error).toContain("15자");
  });

  /** ADMIN 계정 생성은 권한 상승이므로 step-up 재인증을 통과해야만 가능하다. */
  it("ADMIN 계정 생성은 step-up 재인증 없이는 403을 반환한다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password); // elevate 하지 않음

    const payload = {
      username: `newadmin_${Date.now()}`,
      password: "admin-strong-password-2026",
      displayName: "새 관리자",
      role: "ADMIN",
    };

    const blocked = await admin.post("/api/staff/admin/users").set("X-BoardBite-Client", "1").send(payload);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("STEP_UP_REQUIRED");

    // 같은 요청이 step-up 이후에는 통과한다.
    await elevate(admin, password);
    const allowed = await admin.post("/api/staff/admin/users").set("X-BoardBite-Client", "1").send(payload);
    expect(allowed.status).toBe(201);
  });

  /** 일반 직원 계정 생성은 step-up 없이 그대로 가능해야 한다(운영 편의). */
  it("직원 계정 생성은 step-up 없이 가능하다", async () => {
    const admin = await loginAsAdmin();
    const res = await admin
      .post("/api/staff/admin/users")
      .set("X-BoardBite-Client", "1")
      .send({ username: `pos_${Date.now()}`, password: "kitchen-pw-2026", displayName: "주방", role: "POS" });
    expect(res.status).toBe(201);
  });

  it("이미 존재하는 username으로 사용자 생성 시도 시 409를 반환한다", async () => {
    const admin = await loginAsAdmin();
    const { username } = await createStaff("FRONT");

    const res = await admin
      .post("/api/staff/admin/users")
      .set("X-BoardBite-Client", "1")
      .send({ username, password: "longenoughpw1", displayName: "중복아이디", role: "FRONT" });
    expect(res.status).toBe(409);
  });

  it("메뉴 아이템 가격을 변경하면 MENU_PRICE_CHANGED 감사 로그가 실제로 남는다", async () => {
    const admin = await loginAsAdmin();
    const { menuItem } = await createTableWithMenu();
    expect(menuItem.price).toBe(6000);

    const res = await admin
      .patch(`/api/staff/admin/menu/items/${menuItem.id}`)
      .set("X-BoardBite-Client", "1")
      .send({ price: 7500 });
    expect(res.status).toBe(200);
    expect(res.body.item.price).toBe(7500);

    const log = await prisma.auditLog.findFirst({
      where: { action: "MENU_PRICE_CHANGED", targetId: menuItem.id },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    const metadata = JSON.parse(log!.metadata ?? "{}");
    expect(metadata).toEqual({ from: 6000, to: 7500 });
  });

  it("가격이 실제로 바뀌지 않으면(동일 값) MENU_PRICE_CHANGED 로그가 남지 않는다", async () => {
    const admin = await loginAsAdmin();
    const { menuItem } = await createTableWithMenu();

    const res = await admin
      .patch(`/api/staff/admin/menu/items/${menuItem.id}`)
      .set("X-BoardBite-Client", "1")
      .send({ price: 6000 });
    expect(res.status).toBe(200);

    const log = await prisma.auditLog.findFirst({
      where: { action: "MENU_PRICE_CHANGED", targetId: menuItem.id },
    });
    expect(log).toBeNull();
  });

  it("사용자 PATCH는 step-up 재인증 없이는 403으로 막히고, 재인증 후에는 정상 판정된다", async () => {
    const { username, password } = await createStaff("ADMIN");
    const admin = await loginAgent(username, password);

    const beforeStepUp = await admin
      .patch("/api/staff/admin/users/nonexistent-user-id")
      .set("X-BoardBite-Client", "1")
      .send({ displayName: "유령직원" });
    expect(beforeStepUp.status).toBe(403);
    expect(beforeStepUp.body.code).toBe("STEP_UP_REQUIRED");

    await elevate(admin, password);

    const res = await admin
      .patch("/api/staff/admin/users/nonexistent-user-id")
      .set("X-BoardBite-Client", "1")
      .send({ displayName: "유령직원" });
    expect(res.status).toBe(404);
  });
});
