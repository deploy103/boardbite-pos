import { test, expect } from "@playwright/test";
import { apiAs, createFixture, joinAsCustomer, loginUi, openTableViaUi } from "./helpers.js";

/**
 * 요구사항2.md §9.3 / §12 E2E 3번 — 네트워크 재시도와 멱등성.
 *
 * 가장 위험한 상황은 "요청은 서버에 도착했는데 응답만 유실된 경우"다. 손님 입장에서는
 * 주문이 실패한 것처럼 보이므로 다시 누르게 되는데, 이때 같은 idempotency key가 재사용되어
 * 주문이 두 건 생기지 않아야 한다. 여기서는 첫 응답만 끊어 그 상황을 그대로 재현한다.
 */
test("응답이 유실된 뒤 손님이 다시 주문해도 주문은 1건만 생성된다", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);

  const api = await apiAs(baseURL, "admin");
  const { tableNumber, table, categoryName, itemName } = await createFixture(api, "NETRETRY", 5000);

  const frontCtx = await browser.newContext();
  const frontPage = await frontCtx.newPage();
  await loginUi(frontPage, "front", "/front");
  const joinCode = await openTableViaUi(frontPage, tableNumber);

  const page = await joinAsCustomer(browser, table.publicSlug, joinCode);

  // 첫 주문 요청만: 서버에는 그대로 전달하되(실제로 주문이 생성된다) 응답은 끊는다.
  let dropped = false;
  await page.route("**/api/customer/orders", async (route) => {
    if (route.request().method() !== "POST" || dropped) {
      await route.continue();
      return;
    }
    dropped = true;
    // 서버까지 요청을 보낸 뒤 응답만 버린다 → 브라우저에는 네트워크 오류로 보인다.
    await route.fetch().catch(() => undefined);
    await route.abort("connectionfailed");
  });

  await page.getByRole("tab", { name: categoryName }).click();
  await page.locator(".menu-row", { hasText: itemName }).getByRole("button", { name: "담기" }).click();
  await page.getByRole("button", { name: /장바구니.*확인하기/ }).click();
  await page.getByRole("button", { name: "주문하기" }).click();

  // 손님에게는 "연결할 수 없다"는 안내가 뜨고, 내부 용어는 노출되지 않는다.
  const errorText = page.getByText(/서버에 연결할 수 없어요/);
  await expect(errorText).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Prisma|TableSession|stack/i)).toHaveCount(0);

  // 손님이 다시 주문 버튼을 누른다 — 클라이언트는 같은 idempotency key를 재사용한다.
  await page.getByRole("button", { name: "주문하기" }).click();
  await expect(page.getByText("주문 확인 중")).toBeVisible({ timeout: 15_000 });

  // 서버 기준으로 주문은 정확히 1건, 청구액도 1건분이어야 한다.
  const frontApi = await apiAs(baseURL, "front");
  const { tables } = await (await frontApi.get("/api/staff/front/tables")).json();
  const row = tables.find((t: { id: string }) => t.id === table.id);
  expect(row.bill.totalAmount).toBe(5000);

  const orders = await (await frontApi.get(`/api/staff/front/table-sessions/${row.session.id}/orders`)).json();
  expect(orders.orders).toHaveLength(1);
});
