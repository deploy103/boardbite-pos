import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiAs, createFixture, joinAsCustomer, loginUi, openTableViaUi } from "./helpers.js";

/**
 * 요구사항 9절의 브라우저 검증 흐름:
 * 테이블 주문 생성 → 주방 주문 취소 → 테이블 유지 확인 → 재료 소진 취소 →
 * 품절 항목 선택 → 고객/프론트 화면 품절 반영 → 직접 API 우회 차단 → 판매 재개
 */

async function orderOnce(browser: Parameters<typeof joinAsCustomer>[0], api: APIRequestContext, baseURL: string | undefined, prefix: string) {
  const fixture = await createFixture(api, prefix);
  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await loginUi(frontPage, "front", "/front");
  const joinCode = await openTableViaUi(frontPage, fixture.tableNumber);
  const customer = await joinAsCustomer(browser, fixture.table.publicSlug, joinCode);

  await customer.getByRole("tab", { name: fixture.categoryName }).click();
  await customer.locator(".menu-row", { hasText: fixture.itemName }).getByRole("button", { name: "담기" }).click();
  await customer.getByRole("button", { name: /장바구니.*확인하기/ }).click();
  await customer.getByRole("button", { name: "주문하기" }).click();
  await expect(customer.getByText("주문 확인 중")).toBeVisible({ timeout: 10_000 });
  void baseURL;
  return { ...fixture, frontPage, customer };
}

test("주방에서 주문을 취소해도 테이블이 닫히지 않는다", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const api = await apiAs(baseURL, "admin");
  const { tableNumber, table, itemName, frontPage } = await orderOnce(browser, api, baseURL, "취소");

  const posCtx = await browser.newContext();
  const posPage = await posCtx.newPage();
  await loginUi(posPage, "pos", "/pos");

  const card = posPage.locator(".kds-card", { hasText: `${tableNumber}번` });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "취소" }).click();

  const dialog = posPage.getByRole("dialog", { name: "주문 취소" });
  await expect(dialog.getByText("취소해도 테이블은 닫히지 않습니다.")).toBeVisible();
  await dialog.getByRole("radio").nth(1).check(); // 고객 요청
  await dialog.getByRole("button", { name: "취소하기" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  // 테이블이 여전히 이용중이다.
  await frontPage.reload();
  const tableCard = frontPage.locator(".table-card", { hasText: `${tableNumber}번` });
  await expect(tableCard).toContainText("이용중", { timeout: 15_000 });

  // 서버 상태로도 확인한다.
  const tables = await (await api.get("/api/staff/admin/tables")).json();
  expect(tables.tables.find((t: { id: string }) => t.id === table.id).status).toBe("OPEN");
  void itemName;
});

test("재료 소진 취소로 품절 처리하면 손님·FRONT 화면에 반영되고 API 우회 주문도 막힌다", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const api = await apiAs(baseURL, "admin");
  const { tableNumber, itemName, item, categoryName, customer } = await orderOnce(browser, api, baseURL, "소진");

  const posCtx = await browser.newContext();
  const posPage = await posCtx.newPage();
  await loginUi(posPage, "pos", "/pos");

  const card = posPage.locator(".kds-card", { hasText: `${tableNumber}번` });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "취소" }).click();

  const dialog = posPage.getByRole("dialog", { name: "주문 취소" });
  // 재료 소진은 바로 취소하지 않고 품절 선택 단계로 넘어간다.
  await dialog.getByRole("radio").first().check();
  await dialog.getByRole("button", { name: "다음: 품절 선택" }).click();
  await expect(dialog.getByText("무엇이 떨어졌나요?")).toBeVisible();

  // 하나도 고르지 않으면 확정할 수 없다.
  await expect(dialog.getByRole("button", { name: "취소하고 품절 처리" })).toBeDisabled();

  await dialog.locator(".option-choice", { hasText: itemName }).click();
  await expect(dialog.getByText(/함께 품절됩니다/)).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "취소하고 품절 처리" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });

  // 손님 화면에 품절이 즉시 반영된다(소켓 → 메뉴 재조회).
  await customer.getByRole("tab", { name: "메뉴" }).click();
  await customer.getByRole("tab", { name: categoryName }).click();
  const menuRow = customer.locator(".menu-row", { hasText: itemName });
  await expect(menuRow.getByText("품절")).toBeVisible({ timeout: 15_000 });

  // 품절 표시를 우회해 API를 직접 불러도 주문이 만들어지지 않는다.
  const bypass = await customer.request.post("/api/customer/orders", {
    headers: { "X-BoardBite-Client": "1" },
    data: { idempotencyKey: `bypass-${Date.now()}`, items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }] },
  });
  expect(bypass.status()).toBe(400);
  expect((await bypass.json()).code).toBe("MENU_SOLD_OUT");

  // FRONT 현장 결제 화면에서도 품절로 보인다(공통 채널 메뉴).
  const frontCtx2 = await browser.newContext();
  const frontPage2 = await frontCtx2.newPage();
  await loginUi(frontPage2, "front", "/front");
  await frontPage2.goto("/front/counter");
  const counterMenu = await (await api.get("/api/staff/admin/menu/categories")).json();
  const shown = (counterMenu.categories as { items: { id: string; isSoldOut: boolean }[] }[])
    .flatMap((c) => c.items)
    .find((i) => i.id === item.id);
  expect(shown?.isSoldOut).toBe(true);

  // 판매 재개하면 다시 주문 가능해진다.
  const resume = await api.post("/api/staff/admin/inventory/sold-out", {
    data: { targets: [{ kind: "MENU_ITEM", id: item.id }], soldOut: false },
  });
  expect(resume.ok()).toBeTruthy();
  const after = await customer.request.post("/api/customer/orders", {
    headers: { "X-BoardBite-Client": "1" },
    data: { idempotencyKey: `after-${Date.now()}`, items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }] },
  });
  expect(after.status()).toBe(201);
});
