import { request as pwRequest } from "@playwright/test";
import { BOOTSTRAP_ADMIN_PASSWORD, CREDENTIALS, STAFF_ROLES } from "./tests/helpers.js";

/**
 * 행사 전 운영 절차를 그대로 한 번 수행한다(요구사항2.md §2.4 / §15 배포 전 체크리스트).
 *
 * 시드는 부트스트랩 ADMIN 계정 하나만 만든다. 그 계정은 `mustResetPassword=true`라
 * 업무 API가 전부 403이므로, 여기서
 *   1) ADMIN 초기 비밀번호를 운영 비밀번호로 한 번 바꾸고,
 *   2) 그 ADMIN으로 FRONT/POS/SERVING 직원 계정을 관리자 API로 등록한다.
 * 실제 운영자가 밟는 경로와 동일하다 — 직원 계정은 관리자 화면에서만 만들어진다.
 *
 * 강제 변경 화면 자체는 forced-password-change.spec.ts가 새 계정으로 따로 검증한다.
 */
export default async function globalSetup() {
  const baseURL = "http://127.0.0.1:4173";

  const admin = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "X-BoardBite-Client": "1" } });

  const login = await admin.post("/api/staff/login", {
    data: { username: CREDENTIALS.admin.username, password: BOOTSTRAP_ADMIN_PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`[global-setup] admin 초기 로그인 실패: ${login.status()}`);
  }

  const changed = await admin.post("/api/staff/change-password", {
    data: { currentPassword: BOOTSTRAP_ADMIN_PASSWORD, newPassword: CREDENTIALS.admin.password },
  });
  if (!changed.ok()) {
    throw new Error(`[global-setup] admin 비밀번호 변경 실패: ${changed.status()} ${await changed.text()}`);
  }

  // 비밀번호 변경으로 authVersion이 올라 기존 세션이 끊기므로 새 비밀번호로 다시 로그인한다.
  const relogin = await admin.post("/api/staff/login", { data: CREDENTIALS.admin });
  if (!relogin.ok()) {
    throw new Error(`[global-setup] admin 재로그인 실패: ${relogin.status()}`);
  }

  for (const [key, role] of Object.entries(STAFF_ROLES)) {
    const who = key as keyof typeof STAFF_ROLES;
    const created = await admin.post("/api/staff/admin/users", {
      data: {
        username: CREDENTIALS[who].username,
        password: CREDENTIALS[who].password,
        displayName: CREDENTIALS[who].username,
        role,
      },
    });
    if (!created.ok()) {
      throw new Error(`[global-setup] ${who} 계정 생성 실패: ${created.status()} ${await created.text()}`);
    }
  }

  await admin.dispose();
}
