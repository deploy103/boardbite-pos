import { test, expect, request as pwRequest, devices } from "@playwright/test";

// 손님이 보는 /t/:slug 화면은 실제로는 거의 항상 휴대폰으로 접속하므로(요구사항.md §7),
// 손님 대면 시나리오(I, D)는 iPhone 13 프로필로 띄운다. 특히 시나리오 D(더블탭)는 실제
// 터치스크린 상호작용을 흉내내는 테스트라 모바일 프로필로 돌리는 편이 더 실효성 있다.
const customerDevice = devices["iPhone 13"];

test.describe("보안/엣지 케이스 (요구사항.md §21 시나리오 D, H, I)", () => {
  test("시나리오 I: OPEN되지 않은 테이블은 QR을 찍어도 주문 화면 대신 안내 문구가 보인다", async ({ browser, baseURL }) => {
    const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "X-BoardBite-Client": "1" } });
    await api.post("/api/staff/login", { data: { username: "admin", password: "e2e-admin-pw-12345678" } });

    const tableNumber = Math.floor(Math.random() * 900_000) + 100_000;
    const tableRes = await api.post("/api/staff/admin/tables", { data: { number: tableNumber } });
    const { table } = await tableRes.json();

    const customerCtx = await browser.newContext({ ...customerDevice });
    const page = await customerCtx.newPage();
    await page.goto(`/t/${table.publicSlug}`);
    await expect(page.getByText("현재 주문 가능한 테이블이 아닙니다")).toBeVisible({ timeout: 10_000 });
    // 메뉴 화면(담기 버튼)은 절대 보이면 안 된다.
    await expect(page.getByRole("button", { name: "담기" })).toHaveCount(0);
  });

  test("시나리오 H: POS 계정으로 /admin에 직접 접속하면 관리자 화면이 아니라 로그인 화면으로 돌아간다", async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/staff/login");
    await page.getByPlaceholder("아이디").fill("pos");
    await page.getByPlaceholder("비밀번호").fill("e2e-pos-pw-12345678");
    await page.getByRole("button", { name: "로그인하기" }).click();
    await page.waitForURL("**/pos");

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
    const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "X-BoardBite-Client": "1" } });
    await api.post("/api/staff/login", { data: { username: "admin", password: "e2e-admin-pw-12345678" } });

    const tableNumber = Math.floor(Math.random() * 900_000) + 100_000;
    const tableRes = await api.post("/api/staff/admin/tables", { data: { number: tableNumber } });
    const { table } = await tableRes.json();
    const categoryName = `E2E-dbl-${tableNumber}`;
    const itemName = `더블탭메뉴-${tableNumber}`;
    const catRes = await api.post("/api/staff/admin/menu/categories", { data: { name: categoryName } });
    const { category } = await catRes.json();
    await api.post("/api/staff/admin/menu/items", {
      data: { categoryId: category.id, name: itemName, price: 4000 },
    });

    const frontApi = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "X-BoardBite-Client": "1" } });
    await frontApi.post("/api/staff/login", { data: { username: "front", password: "e2e-front-pw-12345678" } });
    await frontApi.post(`/api/staff/front/tables/${table.id}/open`, { data: { guestCount: 1 } });

    const customerCtx = await browser.newContext({ ...customerDevice });
    const page = await customerCtx.newPage();
    await page.goto(`/t/${table.publicSlug}`);
    // 서버를 재사용하는 다른 E2E 테스트들이 이미 다른 카테고리/메뉴를 만들어뒀을 수 있으므로
    // (같은 실행 안에서 서버/DB를 공유), 이 테스트에서 만든 카테고리 탭으로 명시적으로 이동한다.
    await page.getByRole("tab", { name: categoryName }).click();
    const menuRow = page.locator(".menu-row", { hasText: itemName });
    await menuRow.getByRole("button", { name: "담기" }).click();
    const cartCta = page.getByRole("button", { name: /장바구니.*확인하기/ });
    await cartCta.click();
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

    // ADMIN의 /tables는 청구서를 포함하지 않으므로(요약 목록), 청구서가 포함된 FRONT 목록으로 확인한다.
    const tablesRes = await frontApi.get("/api/staff/front/tables");
    const { tables } = await tablesRes.json();
    const reopened = tables.find((t: { id: string }) => t.id === table.id);
    expect(reopened.bill.totalAmount).toBe(4000); // 8000이면 중복 생성된 것 — 반드시 1건(4000원)만 남아야 한다.
  });
});
