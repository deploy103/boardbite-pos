import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * 요구사항2.md §12 E2E 7번 — production과 동일한 조건에서 핵심 흐름이 도는지 확인한다.
 *
 * 이 프로젝트만 NODE_ENV=production으로 뜬 별도 서버(자체 서명 HTTPS 프록시 뒤)를 대상으로 한다.
 * 확인하려는 것:
 *   1) 세션/손님 쿠키에 Secure 속성이 붙고도 로그인·입장이 정상 동작하는가
 *   2) production 기동 검증(assertProductionEnv)을 통과한 서버에서 주문~정산이 끝까지 도는가
 *   3) ADMIN은 MFA를 설정하기 전까지 관리 기능을 쓸 수 없는가
 *   4) 직원 계정이 "ADMIN 화면에서만" 만들어지는 경로가 production에서도 성립하는가
 *
 * 시드가 만드는 계정은 부트스트랩 ADMIN 하나뿐이다. ADMIN 비밀번호는 production 정책(15자 이상)을
 * 따르고, FRONT/POS/SERVING 계정은 ADMIN이 MFA까지 마친 뒤 관리자 API로 직접 등록한다.
 */

const INITIAL_ADMIN_PASSWORD = "e2e-secure-admin-initial-pw-01";

const OPERATIONAL = {
  admin: "e2e-secure-admin-operational-2026",
  front: "e2e-secure-front-operational-2026",
  pos: "e2e-secure-pos-operational-2026",
  serving: "e2e-secure-serving-operational-2026",
} as const;

/** ADMIN이 만들어야 하는 직원 계정(아이디 = 키, 역할 = 값). */
const STAFF_ROLES = {
  front: "FRONT",
  pos: "POS",
  serving: "SERVING",
} as const;

function secureContext(baseURL: string | undefined) {
  return pwRequest.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-BoardBite-Client": "1" },
  });
}

/** ADMIN이 등록해 둔 직원 계정으로 로그인한 API 컨텍스트를 돌려준다. */
async function loginAs(baseURL: string | undefined, who: keyof typeof STAFF_ROLES) {
  const api = await secureContext(baseURL);
  const res = await api.post("/api/staff/login", { data: { username: who, password: OPERATIONAL[who] } });
  expect(res.ok(), `${who} 로그인 실패: ${res.status()}`).toBeTruthy();
  return api;
}

test("production 조건(HTTPS + Secure 쿠키)에서 주문→조리→서빙→정산이 끝까지 동작한다", async ({ baseURL }) => {
  test.setTimeout(90_000);

  // ---------- 세션 쿠키에 Secure가 붙는지 먼저 확인 ----------
  // 이 시점에 존재하는 계정은 부트스트랩 ADMIN 하나뿐이라 그 계정으로 확인한다.
  const raw = await secureContext(baseURL);
  const loginRes = await raw.post("/api/staff/login", {
    data: { username: "admin", password: INITIAL_ADMIN_PASSWORD },
  });
  expect(loginRes.ok()).toBeTruthy();
  const sessionCookie = (await raw.storageState()).cookies.find((c) => c.name === "boardbite.sid");
  expect(sessionCookie, "세션 쿠키가 발급되지 않았다").toBeTruthy();
  expect(sessionCookie!.secure, "production에서는 세션 쿠키에 Secure가 붙어야 한다").toBe(true);
  expect(sessionCookie!.httpOnly).toBe(true);
  expect(sessionCookie!.sameSite).toBe("Lax");
  await raw.dispose();

  // ---------- ADMIN 온보딩(강제 비밀번호 변경) ----------
  const admin = await secureContext(baseURL);
  expect(
    (await admin.post("/api/staff/login", { data: { username: "admin", password: INITIAL_ADMIN_PASSWORD } })).ok(),
    "admin 초기 로그인 실패",
  ).toBeTruthy();
  const changed = await admin.post("/api/staff/change-password", {
    data: { currentPassword: INITIAL_ADMIN_PASSWORD, newPassword: OPERATIONAL.admin },
  });
  expect(changed.ok(), `admin 비밀번호 변경 실패: ${await changed.text()}`).toBeTruthy();
  expect(
    (await admin.post("/api/staff/login", { data: { username: "admin", password: OPERATIONAL.admin } })).ok(),
    "admin 재로그인 실패",
  ).toBeTruthy();

  // ---------- ADMIN은 MFA 설정 전까지 관리 기능을 쓸 수 없다 ----------
  const beforeMfa = await admin.get("/api/staff/admin/users");
  expect(beforeMfa.status()).toBe(403);
  expect((await beforeMfa.json()).code).toBe("MFA_SETUP_REQUIRED");

  // 인증 앱 등록을 코드로 재현한다(secret은 설정 응답에서만 나온다).
  const setup = await admin.post("/api/staff/mfa/setup", { data: { currentPassword: OPERATIONAL.admin } });
  expect(setup.ok()).toBeTruthy();
  const { secret } = await setup.json();
  const { generateTotp } = await import("../../server/src/auth/totp.js");
  const enable = await admin.post("/api/staff/mfa/enable", { data: { token: generateTotp(secret) } });
  expect(enable.ok()).toBeTruthy();

  // 이제 관리 기능이 열린다.
  expect((await admin.get("/api/staff/admin/users")).status()).toBe(200);

  // ---------- 직원 계정은 ADMIN만 만들 수 있다 ----------
  for (const [username, role] of Object.entries(STAFF_ROLES)) {
    const created = await admin.post("/api/staff/admin/users", {
      data: {
        username,
        password: OPERATIONAL[username as keyof typeof STAFF_ROLES],
        displayName: username,
        role,
      },
    });
    expect(created.ok(), `${username} 계정 생성 실패: ${created.status()} ${await created.text()}`).toBeTruthy();
  }

  const front = await loginAs(baseURL, "front");
  const pos = await loginAs(baseURL, "pos");
  const serving = await loginAs(baseURL, "serving");

  // ---------- 테이블/메뉴 준비 ----------
  const tableNumber = Math.floor(Math.random() * 900_000) + 100_000;
  const { table } = await (await admin.post("/api/staff/admin/tables", { data: { number: tableNumber } })).json();
  const { category } = await (
    await admin.post("/api/staff/admin/menu/categories", { data: { name: `SECURE-${tableNumber}` } })
  ).json();
  const { item } = await (
    await admin.post("/api/staff/admin/menu/items", {
      data: { categoryId: category.id, name: `보안메뉴-${tableNumber}`, price: 7000 },
    })
  ).json();

  // ---------- FRONT: 테이블 열기 + 입장 코드 ----------
  const opened = await front.post(`/api/staff/front/tables/${table.id}/open`, { data: { guestCount: 2 } });
  expect(opened.ok()).toBeTruthy();
  const { session, joinCode } = await opened.json();
  expect(joinCode).toMatch(/^\d{6}$/);

  // ---------- 손님: 입장 코드로만 입장 가능 ----------
  const customer = await pwRequest.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-BoardBite-Client": "1" },
  });

  // 코드 없이 접근하면 막힌다.
  expect((await customer.get("/api/customer/menu")).status()).toBe(403);

  const joined = await customer.post(`/api/customer/join/${table.publicSlug}`, { data: { joinCode } });
  expect(joined.ok()).toBeTruthy();

  const customerCookie = (await customer.storageState()).cookies.find((c) => c.name === "boardbite_customer");
  expect(customerCookie, "손님 기기 쿠키가 발급되지 않았다").toBeTruthy();
  expect(customerCookie!.secure, "production에서는 손님 쿠키에도 Secure가 붙어야 한다").toBe(true);
  expect(customerCookie!.httpOnly).toBe(true);

  // ---------- 주문 → 조리 → 서빙 ----------
  const order = await customer.post("/api/customer/orders", {
    data: {
      idempotencyKey: `secure-${tableNumber}`,
      items: [{ menuItemId: item.id, quantity: 1, optionChoiceIds: [] }],
    },
  });
  expect(order.ok()).toBeTruthy();
  const orderId = (await order.json()).order.id;

  for (const step of ["accept", "start-preparing", "ready"]) {
    const res = await pos.post(`/api/staff/pos/orders/${orderId}/${step}`);
    expect(res.ok(), `POS ${step} 실패`).toBeTruthy();
  }
  expect((await serving.post(`/api/staff/serving/orders/${orderId}/served`)).ok()).toBeTruthy();

  // ---------- 정산 → 자동 CLOSE ----------
  const paid = await front.post(`/api/staff/front/table-sessions/${session.id}/payments`, {
    data: { idempotencyKey: `secure-pay-${tableNumber}`, methodCode: "CARD", mode: "AMOUNT", amount: 7000 },
  });
  expect(paid.ok()).toBeTruthy();
  expect((await paid.json()).settlement).toBe("CLOSED");

  const finalTables = await (await admin.get("/api/staff/admin/tables")).json();
  expect(finalTables.tables.find((t: { id: string }) => t.id === table.id).status).toBe("AVAILABLE");

  // 종료된 세션의 손님 기기는 즉시 무효화된다.
  expect((await customer.get("/api/customer/session")).status()).toBe(403);
});
