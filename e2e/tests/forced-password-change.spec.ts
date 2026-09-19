import { test, expect } from "@playwright/test";
import { apiAs, CREDENTIALS, loginUi } from "./helpers.js";

/**
 * 요구사항2.md §2.4 — mustResetPassword 실제 강제.
 * ADMIN이 새로 만든 계정은 첫 로그인에서 반드시 비밀번호 변경 화면으로 가고,
 * 변경 전에는 업무 화면을 쓸 수 없어야 한다.
 */
test("새 직원 계정은 첫 로그인에서 비밀번호를 바꿔야 업무 화면에 들어간다", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);

  const api = await apiAs(baseURL, "admin");
  const username = `newstaff${Date.now()}`;
  const initialPassword = "initial-temp-password-1234";
  const newPassword = "my-own-strong-password-2026";

  const created = await api.post("/api/staff/admin/users", {
    data: { username, password: initialPassword, displayName: "신규 직원", role: "POS" },
  });
  expect(created.ok()).toBeTruthy();

  // ADMIN이 비밀번호를 초기화하면 mustResetPassword가 켜진다.
  const { id } = await created.json();
  await api.post("/api/staff/step-up", { data: { password: CREDENTIALS.admin.password } });
  const reset = await api.post(`/api/staff/admin/users/${id}/reset-password`, {
    data: { newPassword: initialPassword },
  });
  expect(reset.ok()).toBeTruthy();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/staff/login");
  await page.getByPlaceholder("아이디").fill(username);
  await page.getByPlaceholder("비밀번호").fill(initialPassword);
  await page.getByRole("button", { name: "로그인하기" }).click();

  // 업무 화면(/pos)이 아니라 비밀번호 변경 화면으로 간다.
  await page.waitForURL("**/staff/change-password", { timeout: 10_000 });
  await expect(page.getByText("초기 비밀번호를 사용 중이에요")).toBeVisible();

  // 이 상태에서 업무 API는 막혀 있다.
  const blocked = await page.request.get(`${baseURL}/api/staff/pos/board`);
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).code).toBe("PASSWORD_RESET_REQUIRED");

  await page.getByPlaceholder("현재 비밀번호").fill(initialPassword);
  await page.getByPlaceholder("새 비밀번호", { exact: true }).fill(newPassword);
  await page.getByPlaceholder("새 비밀번호 확인").fill(newPassword);
  await page.getByRole("button", { name: "비밀번호 변경" }).click();

  // 변경 후에는 본래 역할 화면으로 이동하고 업무 API도 열린다.
  await page.waitForURL("**/pos", { timeout: 10_000 });
  const allowed = await page.request.get(`${baseURL}/api/staff/pos/board`);
  expect(allowed.status()).toBe(200);
});
