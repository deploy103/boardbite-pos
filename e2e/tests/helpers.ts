import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { request as pwRequest, devices } from "@playwright/test";

/** 손님은 실제로 거의 항상 휴대폰으로 접속하므로(요구사항.md §7) 손님 컨텍스트만 모바일 프로필로 띄운다. */
export const customerDevice = devices["iPhone 13"];

/**
 * 시드가 만드는 계정은 부트스트랩 ADMIN 하나뿐이고, 그 계정은 `mustResetPassword=true` 상태라
 * 업무 화면에 들어갈 수 없다(요구사항2.md §2.4). 실제 운영에서도 행사 전에 담당자가 한 번
 * 바꾸고 시작하므로, E2E도 global-setup에서 동일하게 "초기 비밀번호 → 운영 비밀번호"
 * 전환을 한 번 수행한다.
 *
 * FRONT/POS/SERVING 계정은 시드되지 않는다 — global-setup이 이 ADMIN으로 로그인해
 * 관리자 API(POST /api/staff/admin/users)로 만든다. 실제 운영 절차와 같은 경로다.
 */
export const BOOTSTRAP_ADMIN_PASSWORD = "e2e-admin-pw-12345678";

/** global-setup이 ADMIN 화면에서 만드는 직원 계정들(역할별 1개). */
export const STAFF_ROLES = {
  front: "FRONT",
  pos: "POS",
  serving: "SERVING",
} as const;

/** 온보딩/생성을 마친 뒤 모든 테스트가 사용하는 자격 증명. */
export const CREDENTIALS = {
  admin: { username: "admin", password: "e2e-admin-operational-pw-2026" },
  front: { username: "front", password: "e2e-front-operational-pw-2026" },
  pos: { username: "pos", password: "e2e-pos-operational-pw-2026" },
  serving: { username: "serving", password: "e2e-serving-operational-pw-2026" },
} as const;

export async function apiAs(baseURL: string | undefined, who: keyof typeof CREDENTIALS): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "X-BoardBite-Client": "1" } });
  const res = await api.post("/api/staff/login", { data: CREDENTIALS[who] });
  expect(res.ok(), `${who} 로그인 실패`).toBeTruthy();
  return api;
}

/** 테스트마다 고유한 테이블 + 카테고리 + 메뉴를 만들어 실행 간 데이터가 섞이지 않게 한다. */
export async function createFixture(api: APIRequestContext, prefix: string, price = 6000) {
  const tableNumber = Math.floor(Math.random() * 900_000) + 100_000;
  const { table } = await (await api.post("/api/staff/admin/tables", { data: { number: tableNumber } })).json();

  const categoryName = `${prefix}-${tableNumber}`;
  const itemName = `${prefix}메뉴-${tableNumber}`;
  const { category } = await (await api.post("/api/staff/admin/menu/categories", { data: { name: categoryName } })).json();
  const { item } = await (
    await api.post("/api/staff/admin/menu/items", { data: { categoryId: category.id, name: itemName, price } })
  ).json();

  return { tableNumber, table, categoryName, itemName, item };
}

export async function loginUi(page: Page, who: keyof typeof CREDENTIALS, expectPath: string) {
  await page.goto("/staff/login");
  await page.getByPlaceholder("아이디").fill(CREDENTIALS[who].username);
  await page.getByPlaceholder("비밀번호").fill(CREDENTIALS[who].password);
  await page.getByRole("button", { name: "로그인하기" }).click();
  await page.waitForURL(`**${expectPath}`);
}

/**
 * FRONT 화면에서 테이블을 열고, 화면에 표시된 이번 세션 입장 코드를 읽어 돌려준다.
 * 평문 코드는 서버 DB에 저장되지 않으므로 이 화면이 유일한 전달 경로다(요구사항2.md §2.2).
 */
export async function openTableViaUi(frontPage: Page, tableNumber: number): Promise<string> {
  const tableCard = frontPage.locator(".table-card", { hasText: `${tableNumber}번` });
  await expect(tableCard).toBeVisible();
  await tableCard.getByRole("button", { name: "자리 배정" }).click();
  await tableCard.getByRole("button", { name: "테이블 열기" }).click();

  const codeCard = frontPage.locator(".join-code-card");
  await expect(codeCard).toBeVisible({ timeout: 10_000 });
  const joinCode = (await codeCard.locator(".join-code-value").innerText()).trim();
  expect(joinCode).toMatch(/^\d{6}$/);

  await codeCard.getByRole("button", { name: "확인했어요" }).click();
  return joinCode;
}

/** 손님 브라우저로 QR 주소를 열고 입장 코드를 입력해 주문 화면까지 진입시킨다. */
export async function joinAsCustomer(browser: Browser, slug: string, joinCode: string): Promise<Page> {
  const ctx = await browser.newContext({ ...customerDevice });
  const page = await ctx.newPage();
  await page.goto(`/t/${slug}`);
  await expect(page.getByText("입장 코드를 입력해 주세요")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("000000").fill(joinCode);
  await page.getByRole("button", { name: "입장하기" }).click();
  await expect(page.getByRole("tab", { name: "메뉴" })).toBeVisible({ timeout: 10_000 });
  return page;
}
