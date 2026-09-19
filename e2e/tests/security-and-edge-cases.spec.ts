import { test, expect } from "@playwright/test";
import { apiAs, createFixture, CREDENTIALS, customerDevice, joinAsCustomer, loginUi, openTableViaUi } from "./helpers.js";

test.describe("보안/엣지 케이스", () => {
  test("시나리오 I: OPEN되지 않은 테이블은 QR을 찍어도 주문 화면 대신 안내 문구가 보인다", async ({ browser, baseURL }) => {
    const api = await apiAs(baseURL, "admin");
    const { table } = await createFixture(api, "CLOSED");

    const customerCtx = await browser.newContext({ ...customerDevice });
    const page = await customerCtx.newPage();
    await page.goto(`/t/${table.publicSlug}`);
    await expect(page.getByText("현재 주문 가능한 테이블이 아닙니다")).toBeVisible({ timeout: 10_000 });
    // 메뉴 화면(담기 버튼)도, 입장 코드 입력칸도 보이면 안 된다.
    await expect(page.getByRole("button", { name: "담기" })).toHaveCount(0);
    await expect(page.getByPlaceholder("000000")).toHaveCount(0);
  });

  test("시나리오 H: POS 계정으로 /admin에 직접 접속하면 관리자 화면이 아니라 로그인 화면으로 돌아간다", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginUi(page, "pos", "/pos");

    // 클라이언트가 role을 선택하는 게 아니라, POS 계정으로 /admin URL을 직접 쳐도 차단되어야 한다.
    // useStaffMe가 /api/staff/me 응답을 받은 뒤 window.location.href로 하드 리다이렉트하는데,
    // 이 리다이렉트가 /admin 최초 로드의 load 이벤트보다 먼저 일어나면 그 내비게이션 자체가
    // net::ERR_ABORTED로 취소된다 — 정상적으로 의도된 동작이므로 goto의 실패는 무시하고
    // 최종적으로 로그인 화면에 도착하는지만 확인한다.
    await page.goto("/admin").catch(() => undefined);
    await page.waitForURL("**/staff/login", { timeout: 10_000 });

    // 서버 API 레벨에서도 동일하게 403이어야 한다(클라이언트 방어는 보조 수단일 뿐).
    const apiRes = await page.request.get(`${baseURL}/api/staff/admin/users`);
    expect(apiRes.status()).toBe(403);
  });

  test("시나리오 D: 주문 버튼을 빠르게 두 번 눌러도 주문은 1건만 생성된다", async ({ browser, baseURL }) => {
    const api = await apiAs(baseURL, "admin");
    const { tableNumber, table, categoryName, itemName } = await createFixture(api, "DBL", 4000);

    const frontCtx = await browser.newContext();
    const frontPage = await frontCtx.newPage();
    await loginUi(frontPage, "front", "/front");
    const joinCode = await openTableViaUi(frontPage, tableNumber);

    const page = await joinAsCustomer(browser, table.publicSlug, joinCode);
    // 서버를 재사용하는 다른 E2E 테스트들이 이미 다른 카테고리/메뉴를 만들어뒀을 수 있으므로
    // (같은 실행 안에서 서버/DB를 공유), 이 테스트에서 만든 카테고리 탭으로 명시적으로 이동한다.
    await page.getByRole("tab", { name: categoryName }).click();
    const menuRow = page.locator(".menu-row", { hasText: itemName });
    await menuRow.getByRole("button", { name: "담기" }).click();
    await page.getByRole("button", { name: /장바구니.*확인하기/ }).click();
    const orderButton = page.getByRole("button", { name: "주문하기" });

    // 실제 손가락 더블탭처럼 거의 동시에 두 번 클릭한다. 버튼은 첫 클릭에서 즉시(동기적으로)
    // disabled 처리되고 주문이 성공하면 시트 자체가 닫히며 DOM에서 사라지므로, 두 번째 클릭은
    // "비활성화된 엘리먼트"나 "DOM에서 detach된 엘리먼트"를 계속 재시도하다 실패할 수 있다 —
    // 이것 자체가 클라이언트 방어가 정상 동작했다는 뜻이므로 실패를 무시한다. 두 요청이 정말
    // 거의 동시에 서버에 도달하는 경우(진짜 레이스)만 최종 금액 검증으로 판별한다.
    const clickOpts = { timeout: 2_000 };
    await Promise.all([
      orderButton.click(clickOpts).catch(() => undefined),
      orderButton.click(clickOpts).catch(() => undefined),
    ]);

    await expect(page.getByText("주문 확인 중")).toBeVisible({ timeout: 10_000 });

    const frontApi = await apiAs(baseURL, "front");
    const { tables } = await (await frontApi.get("/api/staff/front/tables")).json();
    const reopened = tables.find((t: { id: string }) => t.id === table.id);
    expect(reopened.bill.totalAmount).toBe(4000); // 8000이면 중복 생성된 것 — 반드시 1건(4000원)만 남아야 한다.
  });

  /**
   * 요구사항2.md §2.2 — 과거에 저장해 둔 /t/<slug> 링크로는 미래의 어떤 세션에도 들어갈 수 없다.
   * 이번 테스트는 "손님이 예전 링크를 북마크해 두었다"는 상황 그대로를 재현한다.
   */
  test("저장해 둔 QR 링크와 이전 입장 코드로는 새 세션에 들어갈 수 없다", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);

    const api = await apiAs(baseURL, "admin");
    const { tableNumber, table } = await createFixture(api, "REUSE");

    const frontCtx = await browser.newContext();
    const frontPage = await frontCtx.newPage();
    await loginUi(frontPage, "front", "/front");

    // 1차 손님: 정상 입장 후 테이블 종료
    const firstCode = await openTableViaUi(frontPage, tableNumber);
    const firstCustomer = await joinAsCustomer(browser, table.publicSlug, firstCode);

    await frontPage.reload();
    await frontPage
      .locator(".table-card", { hasText: `${tableNumber}번` })
      .getByRole("button", { name: "테이블 종료" })
      .click();
    await expect(firstCustomer.getByText("현재 주문 가능한 테이블이 아닙니다")).toBeVisible({ timeout: 10_000 });

    // 2차 손님을 위해 같은 테이블을 다시 연다 — 코드는 반드시 새로 발급된다.
    await frontPage.reload();
    const secondCode = await openTableViaUi(frontPage, tableNumber);
    expect(secondCode).not.toBe(firstCode);

    // 이전 손님이 브라우저를 새로고침하면 쿠키가 있어도 입장 코드 화면으로 되돌아간다.
    await firstCustomer.reload();
    await expect(firstCustomer.getByText("입장 코드를 입력해 주세요")).toBeVisible({ timeout: 10_000 });

    // 예전 코드는 통하지 않는다.
    await firstCustomer.getByPlaceholder("000000").fill(firstCode);
    await firstCustomer.getByRole("button", { name: "입장하기" }).click();
    await expect(firstCustomer.getByText("입장 코드가 올바르지 않아요")).toBeVisible({ timeout: 10_000 });
    await expect(firstCustomer.getByRole("tab", { name: "메뉴" })).toHaveCount(0);

    // 새 코드로는 정상 입장된다.
    await firstCustomer.getByPlaceholder("000000").fill(secondCode);
    await firstCustomer.getByRole("button", { name: "입장하기" }).click();
    await expect(firstCustomer.getByRole("tab", { name: "메뉴" })).toBeVisible({ timeout: 10_000 });
  });

  /**
   * 요구사항2.md §3.1 / §2.5.2 — ADMIN 강제 종료는 별도 경로 + 사유 + step-up 재인증이 필요하고,
   * 삭제가 아니라 감사 로그에 기록이 남는 종료여야 한다.
   */
  test("ADMIN 강제 종료는 사유와 재인증을 거쳐야 하고 감사 로그에 남는다", async ({ browser, baseURL }) => {
    test.setTimeout(90_000);

    const api = await apiAs(baseURL, "admin");
    const { tableNumber, table, categoryName, itemName } = await createFixture(api, "FORCE");

    const frontCtx = await browser.newContext();
    const frontPage = await frontCtx.newPage();
    await loginUi(frontPage, "front", "/front");
    const joinCode = await openTableViaUi(frontPage, tableNumber);

    // 미결제 주문을 남겨 일반 종료가 불가능한 상태를 만든다.
    const customerPage = await joinAsCustomer(browser, table.publicSlug, joinCode);
    await customerPage.getByRole("tab", { name: categoryName }).click();
    await customerPage.locator(".menu-row", { hasText: itemName }).getByRole("button", { name: "담기" }).click();
    await customerPage.getByRole("button", { name: /장바구니.*확인하기/ }).click();
    await customerPage.getByRole("button", { name: "주문하기" }).click();
    await expect(customerPage.getByText("주문 확인 중")).toBeVisible({ timeout: 10_000 });

    // ADMIN 화면에서 강제 종료
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await loginUi(adminPage, "admin", "/admin");

    const row = adminPage.locator(".list-row", { hasText: `${tableNumber}번` });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole("button", { name: "강제 종료" }).click();

    // 위험 작업 확인 창 — 사유는 필수다.
    const dangerSheet = adminPage.locator(".danger-sheet");
    await expect(dangerSheet).toBeVisible();
    await expect(dangerSheet.getByRole("button", { name: "강제 종료하기" })).toBeDisabled();
    await dangerSheet.getByPlaceholder(/강제 종료 사유/).fill("행사 종료로 정리");
    await dangerSheet.getByRole("button", { name: "강제 종료하기" }).click();

    // 이어서 step-up 재인증 창이 뜬다.
    await expect(adminPage.getByText("보안 확인")).toBeVisible({ timeout: 10_000 });
    await adminPage.getByPlaceholder("현재 비밀번호").fill(CREDENTIALS.admin.password);
    await adminPage.getByRole("button", { name: "확인하고 계속" }).click();

    // 테이블이 실제로 닫히고, 손님 기기도 무효화된다.
    await expect(adminPage.locator(".list-row", { hasText: `${tableNumber}번` }).getByText("AVAILABLE")).toBeVisible({
      timeout: 15_000,
    });
    await expect(customerPage.getByText("현재 주문 가능한 테이블이 아닙니다")).toBeVisible({ timeout: 15_000 });

    // 삭제가 아니라 "기록이 남는 종료"여야 한다.
    const logs = await (await api.get(`/api/staff/admin/audit-logs?action=TABLE_FORCE_CLOSED&targetId=${table.id}`)).json();
    expect(logs.logs.length).toBeGreaterThan(0);
    expect(logs.logs[0].metadata).toContain("행사 종료로 정리");
  });

  /**
   * 요구사항2.md §12 "권한 분리" — 각 역할은 자기 화면만 쓸 수 있고, 남의 API는 서버가 막는다.
   * (소켓 room 경계는 server/tests/socket-authz.test.ts에서 실제 소켓 연결로 따로 검증한다.)
   */
  test("역할별 권한 경계: 비로그인/타역할은 다른 화면의 API를 쓸 수 없다", async ({ browser, baseURL }) => {
    const anonymous = await browser.newContext();
    const anonPage = await anonymous.newPage();
    await anonPage.goto("/staff/login");

    // 비로그인: 모든 직원 API가 401
    for (const path of ["/api/staff/me", "/api/staff/admin/users", "/api/staff/front/tables", "/api/staff/pos/board"]) {
      expect((await anonPage.request.get(`${baseURL}${path}`)).status(), path).toBe(401);
    }

    // SERVING 계정: 자기 API는 되고 FRONT/ADMIN API는 403
    const servingCtx = await browser.newContext();
    const servingPage = await servingCtx.newPage();
    await loginUi(servingPage, "serving", "/serving");
    expect((await servingPage.request.get(`${baseURL}/api/staff/serving/ready`)).status()).toBe(200);
    expect((await servingPage.request.get(`${baseURL}/api/staff/front/tables`)).status()).toBe(403);
    expect((await servingPage.request.get(`${baseURL}/api/staff/admin/users`)).status()).toBe(403);

    // FRONT 계정: POS 주문 상태 전이 API를 쓸 수 없다
    const frontCtx = await browser.newContext();
    const frontPage = await frontCtx.newPage();
    await loginUi(frontPage, "front", "/front");
    expect((await frontPage.request.get(`${baseURL}/api/staff/pos/board`)).status()).toBe(403);
  });
});
