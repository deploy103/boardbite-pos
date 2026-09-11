import { test, expect, request as pwRequest, devices } from "@playwright/test";

/**
 * 요구사항.md §21 시나리오 A(정상 흐름) 전체를 실제 브라우저로 재현한다.
 * FRONT 오픈 → 고객 주문 → POS 접수/조리/준비완료 → SERVING 완료 → FRONT 현금 정산
 * → 잔액 0 자동 CLOSE → 고객 화면이 자동으로(소켓) CLOSED를 인지하는지까지 확인한다.
 *
 * 테이블/메뉴는 매 실행마다 고유한 번호/이름으로 API를 통해 만들어(ADMIN 계정) 다른
 * 테스트 실행과 데이터가 섞이지 않게 한다.
 *
 * 손님은 실제로는 거의 항상 본인 휴대폰으로 QR을 찍어 접속하므로(요구사항.md §7), 손님
 * 컨텍스트만 iPhone 13 프로필(뷰포트+UA+터치)로 띄운다. FRONT/POS/SERVING은 매장 데스크톱/
 * 태블릿 기준 그대로 둔다 — 스태프 화면까지 모바일로 돌리면 실행 시간만 늘고 실익이 없다.
 */
test("시나리오 A: 정상 흐름 (오픈→주문→조리→서빙→정산→자동CLOSE)", async ({ browser, baseURL }) => {
  test.setTimeout(60_000);

  const api = await pwRequest.newContext({
    baseURL,
    extraHTTPHeaders: { "X-BoardBite-Client": "1" },
  });

  const adminLogin = await api.post("/api/staff/login", {
    data: { username: "admin", password: "e2e-admin-pw-12345678" },
  });
  expect(adminLogin.ok(), "admin 로그인 실패").toBeTruthy();

  const tableNumber = Math.floor(Math.random() * 900_000) + 100_000;
  const tableRes = await api.post("/api/staff/admin/tables", { data: { number: tableNumber } });
  expect(tableRes.ok()).toBeTruthy();
  const { table } = await tableRes.json();

  const categoryName = `E2E-${tableNumber}`;
  const itemName = `E2E메뉴-${tableNumber}`;
  const catRes = await api.post("/api/staff/admin/menu/categories", { data: { name: categoryName } });
  const { category } = await catRes.json();
  const itemRes = await api.post("/api/staff/admin/menu/items", {
    data: { categoryId: category.id, name: itemName, price: 6000 },
  });
  expect(itemRes.ok()).toBeTruthy();

  // ---------- FRONT: 테이블 열기 ----------
  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await frontPage.goto("/staff/login");
  await frontPage.getByPlaceholder("아이디").fill("front");
  await frontPage.getByPlaceholder("비밀번호").fill("e2e-front-pw-12345678");
  await frontPage.getByRole("button", { name: "로그인하기" }).click();
  await frontPage.waitForURL("**/front");

  const tableCard = frontPage.locator(".table-card", { hasText: `${tableNumber}번` });
  await expect(tableCard).toBeVisible();
  await tableCard.getByRole("button", { name: "자리 배정" }).click();
  await tableCard.getByRole("button", { name: "테이블 열기" }).click();
  await expect(tableCard).toContainText("이용중", { timeout: 10_000 });

  // ---------- 손님: 주문 ----------
  const tablesAfterOpen = await (await api.get("/api/staff/admin/tables")).json();
  const openedTable = tablesAfterOpen.tables.find((t: { number: number }) => t.number === tableNumber);
  expect(openedTable, "방금 연 테이블을 찾지 못함").toBeTruthy();

  const customerCtx = await browser.newContext({ ...devices["iPhone 13"] });
  const customerPage = await customerCtx.newPage();
  await customerPage.goto(`/t/${openedTable.publicSlug}`);
  await expect(customerPage.getByText(`${tableNumber}번 테이블`)).toBeVisible();
  // 서버를 재사용하는 다른 테스트가 이미 다른 카테고리를 만들어뒀을 수 있으므로 명시적으로 이동한다.
  await customerPage.getByRole("tab", { name: categoryName }).click();
  await customerPage.locator(".menu-row", { hasText: itemName }).getByRole("button", { name: "담기" }).click();
  await customerPage.getByRole("button", { name: /장바구니.*확인하기/ }).click();
  await customerPage.getByRole("button", { name: "주문하기" }).click();
  await expect(customerPage.getByText("주문 확인 중")).toBeVisible({ timeout: 10_000 });

  // ---------- POS: 접수 → 조리시작 → 준비완료 ----------
  const posCtx = await browser.newContext();
  const posPage = await posCtx.newPage();
  await posPage.goto("/staff/login");
  await posPage.getByPlaceholder("아이디").fill("pos");
  await posPage.getByPlaceholder("비밀번호").fill("e2e-pos-pw-12345678");
  await posPage.getByRole("button", { name: "로그인하기" }).click();
  await posPage.waitForURL("**/pos");

  const orderCard = posPage.locator(".kds-card", { hasText: `${tableNumber}번` });
  await expect(orderCard).toBeVisible({ timeout: 10_000 });
  await orderCard.getByRole("button", { name: "접수" }).click();
  await orderCard.getByRole("button", { name: "조리 시작" }).click();
  await orderCard.getByRole("button", { name: "준비완료" }).click();

  // ---------- SERVING: 서빙 완료 ----------
  const servingCtx = await browser.newContext();
  const servingPage = await servingCtx.newPage();
  await servingPage.goto("/staff/login");
  await servingPage.getByPlaceholder("아이디").fill("serving");
  await servingPage.getByPlaceholder("비밀번호").fill("e2e-serving-pw-12345678");
  await servingPage.getByRole("button", { name: "로그인하기" }).click();
  await servingPage.waitForURL("**/serving");

  const readyCard = servingPage.locator(".kds-card", { hasText: `${tableNumber}번` });
  await expect(readyCard).toBeVisible({ timeout: 10_000 });
  await readyCard.getByRole("button", { name: "서빙 완료" }).click();

  // ---------- FRONT: 정산(현금, 전액) → 자동 CLOSE ----------
  await frontPage.reload();
  const tableCardAfterServe = frontPage.locator(".table-card", { hasText: `${tableNumber}번` });
  await tableCardAfterServe.getByRole("link", { name: "정산" }).click();
  await frontPage.waitForURL("**/front/checkout/**");
  await frontPage.getByRole("button", { name: "결제하기" }).click();
  await expect(frontPage.getByText("정산이 완료됐어요")).toBeVisible({ timeout: 10_000 });

  // ---------- 손님 화면: 소켓으로 CLOSED를 자동 인지 ----------
  await expect(customerPage.getByText("현재 주문 가능한 테이블이 아닙니다")).toBeVisible({ timeout: 10_000 });

  // ---------- 서버 상태로도 최종 확인: 테이블이 다시 빈자리로 ----------
  const finalTables = await (await api.get("/api/staff/admin/tables")).json();
  const finalTable = finalTables.tables.find((t: { id: string }) => t.id === table.id);
  expect(finalTable.status).toBe("AVAILABLE");
});
