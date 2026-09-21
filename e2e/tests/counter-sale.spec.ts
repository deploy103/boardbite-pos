import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiAs, loginUi } from "./helpers.js";

/**
 * 요구사항.md §5~§7 — FRONT 현장 결제를 실제 브라우저로 재현한다.
 * 테이블을 하나도 열지 않고 룰렛/우동을 팔고, 쿠폰을 쓰고, 주방 전달과 수령 완료까지 확인한다.
 */

/** FRONT 전용 현장 제공 상품(조리 없음, KDS 미표시) 하나를 만든다. */
async function createCounterItem(api: APIRequestContext, name: string, price: number) {
  const suffix = Math.floor(Math.random() * 900_000) + 100_000;
  const { category } = await (
    await api.post("/api/staff/admin/menu/categories", { data: { name: `현장-${suffix}` } })
  ).json();
  const { item } = await (
    await api.post("/api/staff/admin/menu/items", {
      data: {
        categoryId: category.id,
        name: `${name}-${suffix}`,
        price,
        channel: "FRONT",
        needsCooking: false,
        showInKitchen: false,
      },
    })
  ).json();
  return { categoryName: `현장-${suffix}`, itemName: `${name}-${suffix}`, item };
}

test("현장 결제: 테이블 없이 룰렛 판매 → 쿠폰 할인 → 거래 이력 확인", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const api = await apiAs(baseURL, "admin");

  const roulette = await createCounterItem(api, "룰렛1회", 500);

  // ADMIN 화면과 같은 API로 500원 금액권 1장을 발급한다.
  const issueRes = await api.post("/api/staff/admin/coupons/batches", {
    data: {
      idempotencyKey: `e2e-${Date.now()}`,
      type: "AMOUNT",
      name: "E2E 금액권",
      amount: 500,
      quantity: 1,
    },
  });
  expect(issueRes.ok(), "쿠폰 발급 실패").toBeTruthy();
  const couponCode: string = (await issueRes.json()).batch.codes[0];

  const tablesBefore = (await (await api.get("/api/staff/admin/tables")).json()).tables.length;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginUi(page, "front", "/front");

  // FRONT 홈에서 현장 결제로 진입한다.
  await page.getByRole("link", { name: "현장 결제 시작" }).click();
  await page.waitForURL("**/front/counter");

  // 메뉴를 담는다(옵션이 없으므로 바로 담긴다).
  await page.getByRole("tab", { name: roulette.categoryName }).click();
  await page.getByRole("button", { name: new RegExp(roulette.itemName) }).click();
  await expect(page.locator(".cart-line")).toHaveCount(1);
  await expect(page.getByText("받을 금액")).toBeVisible();

  // 쿠폰 번호를 확인한다 — 조회만으로는 소진되지 않는다.
  await page.getByLabel("쿠폰 번호").fill(couponCode);
  await page.getByRole("button", { name: "혜택 확인" }).click();
  await expect(page.getByText(`${couponCode}번`)).toBeVisible({ timeout: 10_000 });

  // 전액 할인되어 무료 제공 완료로 확정된다.
  const confirmButton = page.getByRole("button", { name: "무료 제공 완료로 확정" });
  await expect(confirmButton).toBeEnabled({ timeout: 10_000 });
  await confirmButton.click();

  await expect(page.getByText("무료 제공 완료")).toBeVisible({ timeout: 15_000 });
  const saleNo = (await page.locator(".join-code-value").innerText()).trim();
  expect(saleNo).toMatch(/^#\d{3,}$/);

  // 테이블이 새로 생기지 않았다.
  const tablesAfter = (await (await api.get("/api/staff/admin/tables")).json()).tables.length;
  expect(tablesAfter).toBe(tablesBefore);

  // 쿠폰은 사용 완료로 바뀌었고, 매출은 0원이다.
  const coupons = await (await api.get(`/api/staff/admin/coupons?code=${couponCode}`)).json();
  expect(coupons.coupons[0].state).toBe("USED");

  // 거래 이력에서 조회된다.
  await page.getByRole("button", { name: "새 거래 시작" }).click();
  await page.goto("/front");
  await page.getByRole("tab", { name: /현장 거래/ }).click();
  await expect(page.getByText(saleNo.replace("#", "#"))).toBeVisible({ timeout: 10_000 });
});

test("현장 결제: 조리 상품은 결제 후 주방으로 가고 FRONT가 수령 완료 처리한다", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const api = await apiAs(baseURL, "admin");

  const suffix = Math.floor(Math.random() * 900_000) + 100_000;
  const { category } = await (
    await api.post("/api/staff/admin/menu/categories", { data: { name: `혼합-${suffix}` } })
  ).json();
  const { item: udon } = await (
    await api.post("/api/staff/admin/menu/items", {
      data: { categoryId: category.id, name: `현장우동-${suffix}`, price: 3000, channel: "FRONT" },
    })
  ).json();

  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await loginUi(frontPage, "front", "/front");
  await frontPage.goto("/front/counter");

  await frontPage.getByRole("tab", { name: `혼합-${suffix}` }).click();
  await frontPage.getByRole("button", { name: new RegExp(`현장우동-${suffix}`) }).click();

  // 카드 결제로 확정한다.
  await frontPage.getByRole("radiogroup", { name: "결제수단 선택" }).getByRole("button", { name: "카드" }).click();
  await frontPage.getByRole("button", { name: /수납 확인/ }).click();
  await expect(frontPage.getByText("결제 완료")).toBeVisible({ timeout: 15_000 });
  const saleNo = (await frontPage.locator(".join-code-value").innerText()).trim();

  // POS(주방)에 "현장 주문 #번호"로 뜬다 — 테이블 번호가 없어도 화면이 깨지지 않는다.
  const posCtx = await browser.newContext();
  const posPage = await posCtx.newPage();
  await loginUi(posPage, "pos", "/pos");
  // 카드는 상태가 바뀔 때마다 다른 컬럼으로 옮겨가므로 단계마다 다시 찾는다.
  const kdsCard = () => posPage.locator(".kds-card", { hasText: `현장 주문 ${saleNo}` });
  await expect(kdsCard()).toBeVisible({ timeout: 15_000 });

  await kdsCard().getByRole("button", { name: "접수", exact: true }).click();
  await kdsCard().getByRole("button", { name: "조리 시작", exact: true }).click();
  await kdsCard().getByRole("button", { name: "준비완료", exact: true }).click();
  await expect(kdsCard().getByText("서빙 대기")).toBeVisible({ timeout: 15_000 });

  // FRONT 거래 목록에서 주문번호를 확인하고 수령 완료 처리한다.
  await frontPage.getByRole("button", { name: "새 거래 시작" }).click();
  await frontPage.goto("/front");
  await frontPage.getByRole("tab", { name: /현장 거래/ }).click();
  const row = frontPage.locator(".list-row", { hasText: saleNo });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("수령 대기")).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: "수령 완료 처리" }).click();
  await expect(row.getByText("수령 대기")).toHaveCount(0, { timeout: 15_000 });

  void udon;
});

test("손님 옵션: 무료 옵션이 +0원으로 보이고, 선택 옵션은 '선택 안 함'으로 해제된다", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const api = await apiAs(baseURL, "admin");
  const suffix = Math.floor(Math.random() * 900_000) + 100_000;

  // 라면(필수 단일 '종류') + 선택 단일 '리뷰 이벤트' 구성 — 요구사항.md §3.1 예시 그대로.
  const tableNumber = Math.floor(Math.random() * 900_000) + 100_000;
  const { table } = await (await api.post("/api/staff/admin/tables", { data: { number: tableNumber } })).json();
  const { category } = await (
    await api.post("/api/staff/admin/menu/categories", { data: { name: `옵션-${suffix}` } })
  ).json();
  const { item } = await (
    await api.post("/api/staff/admin/menu/items", {
      data: { categoryId: category.id, name: `라면-${suffix}`, price: 3000 },
    })
  ).json();
  const { group: kind } = await (
    await api.post(`/api/staff/admin/menu/items/${item.id}/option-groups`, {
      data: { name: "종류", required: true, multiSelect: false },
    })
  ).json();
  await api.post(`/api/staff/admin/menu/option-groups/${kind.id}/choices`, { data: { name: "신라면", extraPrice: 0 } });
  await api.post(`/api/staff/admin/menu/option-groups/${kind.id}/choices`, { data: { name: "육개장", extraPrice: 0 } });
  const { group: review } = await (
    await api.post(`/api/staff/admin/menu/items/${item.id}/option-groups`, {
      data: { name: "리뷰 이벤트", required: false, multiSelect: false },
    })
  ).json();
  await api.post(`/api/staff/admin/menu/option-groups/${review.id}/choices`, { data: { name: "참여", extraPrice: 0 } });

  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await loginUi(frontPage, "front", "/front");
  const { openTableViaUi, joinAsCustomer } = await import("./helpers.js");
  const joinCode = await openTableViaUi(frontPage, tableNumber);
  const customer = await joinAsCustomer(browser, table.publicSlug, joinCode);

  await customer.getByRole("tab", { name: `옵션-${suffix}` }).click();
  await customer.locator(".menu-row", { hasText: `라면-${suffix}` }).getByRole("button", { name: "담기" }).click();

  // 무료 옵션도 값을 숨기지 않고 +0원으로 명시한다.
  const sheet = customer.locator(".sheet");
  await expect(sheet.locator(".option-choice", { hasText: "신라면" }).getByText("+0원")).toBeVisible();

  // 필수 그룹을 고르기 전에는 담을 수 없다.
  await expect(sheet.getByRole("button", { name: /'종류' 옵션을 선택해 주세요/ })).toBeDisabled();
  await sheet.locator(".option-choice", { hasText: "신라면" }).click();

  // 선택(필수 아님) 단일 옵션은 고른 뒤 '선택 안 함'으로 되돌릴 수 있다.
  await sheet.locator(".option-choice", { hasText: "참여" }).click();
  const clearButton = sheet.getByRole("button", { name: "선택 안 함" });
  await expect(clearButton).toBeVisible();
  await clearButton.click();
  await expect(clearButton).toHaveCount(0);
  await expect(sheet.locator(".option-choice", { hasText: "참여" }).locator("input")).not.toBeChecked();

  // 필수 선택은 유지되므로 담기가 가능하다.
  await sheet.getByRole("button", { name: /담기/ }).click();
  await customer.getByRole("button", { name: /장바구니.*확인하기/ }).click();
  await expect(customer.locator(".cart-line__options")).toContainText("신라면");
  await expect(customer.locator(".cart-line__options")).not.toContainText("참여");
});

test("테이블 정산에서 쿠폰을 쓰면 남은 금액이 줄고 쿠폰이 사용 완료가 된다", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const api = await apiAs(baseURL, "admin");
  const { createFixture, openTableViaUi, joinAsCustomer } = await import("./helpers.js");
  const { tableNumber, table, categoryName, itemName } = await createFixture(api, "쿠폰테이블", 6000);

  const issued = await api.post("/api/staff/admin/coupons/batches", {
    data: {
      idempotencyKey: `e2e-table-${Date.now()}`,
      type: "AMOUNT",
      name: "E2E 테이블 금액권",
      amount: 2000,
      quantity: 1,
    },
  });
  expect(issued.ok(), "쿠폰 발급 실패").toBeTruthy();
  const couponCode: string = (await issued.json()).batch.codes[0];

  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await loginUi(frontPage, "front", "/front");
  const joinCode = await openTableViaUi(frontPage, tableNumber);

  const customer = await joinAsCustomer(browser, table.publicSlug, joinCode);
  await customer.getByRole("tab", { name: categoryName }).click();
  await customer.locator(".menu-row", { hasText: itemName }).getByRole("button", { name: "담기" }).click();
  await customer.getByRole("button", { name: /장바구니.*확인하기/ }).click();
  await customer.getByRole("button", { name: "주문하기" }).click();
  await expect(customer.getByText("주문 확인 중")).toBeVisible({ timeout: 10_000 });

  // FRONT 정산 화면에서 쿠폰을 적용한다.
  const tableCard = frontPage.locator(".table-card", { hasText: `${tableNumber}번` });
  await tableCard.getByRole("link", { name: "정산" }).click();
  await frontPage.waitForURL("**/front/checkout/**");
  await expect(frontPage.getByText("6,000원").first()).toBeVisible({ timeout: 10_000 });

  await frontPage.getByRole("button", { name: "쿠폰 사용" }).click();
  const dialog = frontPage.getByRole("dialog", { name: "쿠폰 사용" });
  await dialog.getByLabel("쿠폰 번호").fill(couponCode);
  await dialog.getByRole("button", { name: "혜택 확인" }).click();
  await expect(dialog.getByText(`${couponCode}번`)).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("적용 후 남는 금액")).toBeVisible();
  await dialog.getByRole("button", { name: "적용하기" }).click();

  // 창이 닫히고 정산 화면의 남은 금액이 4,000원으로 줄어든다.
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  const bill = frontPage.locator(".bill-card").first();
  await expect(bill).toContainText("4,000원", { timeout: 10_000 });
  await expect(bill).toContainText("2,000원"); // 할인금액

  // 쿠폰은 사용 완료가 되고 사용처가 테이블로 기록된다.
  const coupons = await (await api.get(`/api/staff/admin/coupons?code=${couponCode}`)).json();
  expect(coupons.coupons[0].state).toBe("USED");
  expect(coupons.coupons[0].redemption.usedAt.kind).toBe("TABLE");
  expect(coupons.coupons[0].redemption.usedAt.tableNumber).toBe(tableNumber);
});
