import { test, expect } from "@playwright/test";
import {
  apiAs,
  createFixture,
  joinAsCustomerViaQr,
  loginUi,
  openTableViaUiWithQr,
} from "./helpers.js";

/**
 * 직원이 손님에게 코드를 말로 전달할 필요 없이, FRONT 화면의 세션 전용 QR을 스캔하면 바로
 * 입장되는 흐름. 서버의 join code 검증(HMAC 비교, 레이트리밋, 세션 무효화)은 그대로이고
 * QR은 "코드를 옮기는 매체"일 뿐이므로, 6자리 수동 입력 흐름을 검증하는 기존 테스트
 * (customer-access.test.ts, security-and-edge-cases.spec.ts)의 보장은 여기서 다시 다루지 않는다.
 */
test.describe("세션 전용 QR 자동입장", () => {
  test("FRONT 화면의 QR은 표시된 코드를 그대로 담은 세션 전용 URL을 인코딩한다", async ({ browser, baseURL }) => {
    const api = await apiAs(baseURL, "admin");
    const { tableNumber, table } = await createFixture(api, "QRENC");

    const frontCtx = await browser.newContext();
    const frontPage = await frontCtx.newPage();
    await loginUi(frontPage, "front", "/front");

    const { joinCode, qrUrl } = await openTableViaUiWithQr(frontPage, tableNumber);
    expect(qrUrl).toMatch(new RegExp(`/t/${table.publicSlug}\\?code=${joinCode}$`));
  });

  test("손님이 QR로 바로 접속하면 코드 입력 없이 메뉴 화면으로 들어가고, 주소창에서 code가 사라진다", async ({
    browser,
    baseURL,
  }) => {
    const api = await apiAs(baseURL, "admin");
    const { tableNumber } = await createFixture(api, "QRJOIN");

    const frontCtx = await browser.newContext();
    const frontPage = await frontCtx.newPage();
    await loginUi(frontPage, "front", "/front");

    const { qrUrl } = await openTableViaUiWithQr(frontPage, tableNumber);

    const customer = await joinAsCustomerViaQr(browser, qrUrl);
    // JoinCodeGate(수동 입력 화면)를 거치지 않고 바로 메뉴 화면에 도착해야 한다.
    await expect(customer.getByText("입장 코드를 입력해 주세요")).toHaveCount(0);
    // 성공/실패와 무관하게 code 쿼리파라미터는 주소창에서 즉시 제거된다.
    expect(new URL(customer.url()).searchParams.has("code")).toBe(false);
  });

  test("코드가 재발급된 뒤 예전 QR로 접속하면 자동 입장에 실패하고 수동 입력 화면으로 안전하게 폴백된다", async ({
    browser,
    baseURL,
  }) => {
    const api = await apiAs(baseURL, "admin");
    const { tableNumber } = await createFixture(api, "QRSTALE");

    const frontCtx = await browser.newContext();
    const frontPage = await frontCtx.newPage();
    await loginUi(frontPage, "front", "/front");

    const { qrUrl: staleQrUrl } = await openTableViaUiWithQr(frontPage, tableNumber);

    // 같은 테이블의 코드를 재발급한다 — 예전 QR에 박힌 코드는 이제 무효다.
    await frontPage.reload();
    await frontPage
      .locator(".table-card", { hasText: `${tableNumber}번` })
      .getByRole("button", { name: "입장 코드 재발급" })
      .click();
    await expect(frontPage.locator(".join-code-card")).toBeVisible({ timeout: 10_000 });

    const customerCtx = await browser.newContext();
    const customer = await customerCtx.newPage();
    await customer.goto(staleQrUrl);

    // 자동 입장은 실패하지만 화면이 멈추거나 깨지지 않고 수동 입력 화면 + 실패 사유로 폴백된다.
    await expect(customer.getByText("입장 코드를 입력해 주세요")).toBeVisible({ timeout: 10_000 });
    await expect(customer.getByText("입장 코드가 올바르지 않아요")).toBeVisible();
    await expect(customer.getByRole("tab", { name: "메뉴" })).toHaveCount(0);
    expect(new URL(customer.url()).searchParams.has("code")).toBe(false);
  });
});
