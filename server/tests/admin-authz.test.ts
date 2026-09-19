import { describe, it, expect } from "vitest";
import { createStaff, loginAgent, createTableWithMenu, elevate } from "./helpers.js";
import { prisma } from "../src/prisma.js";

async function loginAsAdmin() {
  const { username, password } = await createStaff("ADMIN");
  return loginAgent(username, password);
}

describe("관리자 API 입력 검증 및 감사 로그", () => {
  it("8자 미만 비밀번호로 사용자 생성 시도 시 400을 반환한다", async () => {
    const admin = await loginAsAdmin();
    const res = await admin
      .post("/api/staff/admin/users")
      .set("X-BoardBite-Client", "1")
      .send({ username: `short_${Date.now()}`, password: "short1", displayName: "짧은비번", role: "FRONT" });
    expect(res.status).toBe(400);
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
