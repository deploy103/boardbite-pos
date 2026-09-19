import { test, expect } from "@playwright/test";
import { apiAs, createFixture, joinAsCustomer, loginUi, openTableViaUi } from "./helpers.js";

/**
 * 요구사항.md §21 시나리오 A(정상 흐름) 전체를 실제 브라우저로 재현한다.
 * FRONT 오픈 → 입장 코드 발급 → 손님 입장/주문 → POS 접수/조리/준비완료 → SERVING 완료
 * → FRONT 현금 정산 → 잔액 0 자동 CLOSE → 손님 화면이 소켓으로 CLOSED를 인지하는지까지 확인한다.
 */
test("시나리오 A: 정상 흐름 (오픈→입장코드→주문→조리→서빙→정산→자동CLOSE)", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);

  const api = await apiAs(baseURL, "admin");
  const { tableNumber, table, categoryName, itemName } = await createFixture(api, "E2E");

  // ---------- FRONT: 테이블 열기 + 입장 코드 확인 ----------
  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await loginUi(frontPage, "front", "/front");

  const joinCode = await openTableViaUi(frontPage, tableNumber);
  const tableCard = frontPage.locator(".table-card", { hasText: `${tableNumber}번` });
  await expect(tableCard).toContainText("이용중", { timeout: 10_000 });

  // ---------- 손님: 입장 코드로 들어와 주문 ----------
  const customerPage = await joinAsCustomer(browser, table.publicSlug, joinCode);
  await expect(customerPage.getByText(`${tableNumber}번 테이블`)).toBeVisible();

  await customerPage.getByRole("tab", { name: categoryName }).click();
  await customerPage.locator(".menu-row", { hasText: itemName }).getByRole("button", { name: "담기" }).click();
  await customerPage.getByRole("button", { name: /장바구니.*확인하기/ }).click();
  await customerPage.getByRole("button", { name: "주문하기" }).click();
  await expect(customerPage.getByText("주문 확인 중")).toBeVisible({ timeout: 10_000 });

  // ---------- POS: 접수 → 조리시작 → 준비완료 ----------
  const posCtx = await browser.newContext();
  const posPage = await posCtx.newPage();
  await loginUi(posPage, "pos", "/pos");

  const orderCard = posPage.locator(".kds-card", { hasText: `${tableNumber}번` });
  await expect(orderCard).toBeVisible({ timeout: 10_000 });
  await orderCard.getByRole("button", { name: "접수" }).click();
  await orderCard.getByRole("button", { name: "조리 시작" }).click();
  await orderCard.getByRole("button", { name: "준비완료" }).click();

  // ---------- SERVING: 서빙 완료 ----------
  const servingCtx = await browser.newContext();
  const servingPage = await servingCtx.newPage();
  await loginUi(servingPage, "serving", "/serving");

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

/**
 * 요구사항2.md §3.1 — FRONT 일반 종료는 더 이상 무조건 강제되지 않는다.
 * 미결제가 남은 테이블을 닫으려 하면 화면에 구체적인 사유가 뜨고 세션은 유지된다.
 */
test("부분 결제만 된 테이블은 FRONT 일반 종료로 닫히지 않고 남은 금액이 안내된다", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);

  const api = await apiAs(baseURL, "admin");
  const { tableNumber, table, categoryName, itemName } = await createFixture(api, "PARTIAL", 10_000);

  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await loginUi(frontPage, "front", "/front");
  const joinCode = await openTableViaUi(frontPage, tableNumber);

  const customerPage = await joinAsCustomer(browser, table.publicSlug, joinCode);
  await customerPage.getByRole("tab", { name: categoryName }).click();
  await customerPage.locator(".menu-row", { hasText: itemName }).getByRole("button", { name: "담기" }).click();
  await customerPage.getByRole("button", { name: /장바구니.*확인하기/ }).click();
  await customerPage.getByRole("button", { name: "주문하기" }).click();
  await expect(customerPage.getByText("주문 확인 중")).toBeVisible({ timeout: 10_000 });

  // 4,000원만 부분 결제한다(서버 API로 직접 — 이 테스트의 관심사는 종료 차단이다).
  const frontApi = await apiAs(baseURL, "front");
  const tables = await (await frontApi.get("/api/staff/front/tables")).json();
  const session = tables.tables.find((t: { id: string }) => t.id === table.id).session;
  const partial = await frontApi.post(`/api/staff/front/table-sessions/${session.id}/payments`, {
    data: { idempotencyKey: `partial-${tableNumber}`, methodCode: "CARD", mode: "AMOUNT", amount: 4000 },
  });
  expect(partial.ok()).toBeTruthy();

  // FRONT 화면에서 종료를 시도하면 남은 금액 때문에 막혀야 한다.
  await frontPage.reload();
  const card = frontPage.locator(".table-card", { hasText: `${tableNumber}번` });
  await card.getByRole("button", { name: "테이블 종료" }).click();
  await expect(frontPage.getByText(`${tableNumber}번 테이블을 종료할 수 없어요`)).toBeVisible({ timeout: 10_000 });
  await expect(frontPage.getByText(/미결제 금액 6,000원/)).toBeVisible();

  // 세션은 그대로 살아 있어야 한다.
  const stillOpen = await (await api.get("/api/staff/admin/tables")).json();
  expect(stillOpen.tables.find((t: { id: string }) => t.id === table.id).status).toBe("OPEN");
});
