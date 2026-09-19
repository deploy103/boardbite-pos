import { request as pwRequest } from "@playwright/test";
import { BOOTSTRAP_PASSWORDS, CREDENTIALS } from "./tests/helpers.js";

/**
 * 행사 전 운영 절차를 그대로 한 번 수행한다(요구사항2.md §2.4 / §15 배포 전 체크리스트).
 *
 * 시드된 부트스트랩 계정은 `mustResetPassword=true`라 업무 API가 전부 403이다.
 * 여기서 각 계정의 비밀번호를 한 번 바꿔 "정상 운영 상태"를 만든 뒤 테스트를 시작한다.
 * 강제 변경 화면 자체는 forced-password-change.spec.ts가 새 계정으로 따로 검증한다.
 */
export default async function globalSetup() {
  const baseURL = "http://127.0.0.1:4173";

  for (const role of ["admin", "front", "pos", "serving"] as const) {
    const api = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { "X-BoardBite-Client": "1" } });

    const login = await api.post("/api/staff/login", {
      data: { username: CREDENTIALS[role].username, password: BOOTSTRAP_PASSWORDS[role] },
    });
    if (!login.ok()) {
      throw new Error(`[global-setup] ${role} 초기 로그인 실패: ${login.status()}`);
    }

    const changed = await api.post("/api/staff/change-password", {
      data: { currentPassword: BOOTSTRAP_PASSWORDS[role], newPassword: CREDENTIALS[role].password },
    });
    if (!changed.ok()) {
      throw new Error(`[global-setup] ${role} 비밀번호 변경 실패: ${changed.status()} ${await changed.text()}`);
    }

    await api.dispose();
  }
}
