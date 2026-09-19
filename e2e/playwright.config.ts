import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// production 유사 환경(NODE_ENV=production + HTTPS + Secure 쿠키) 전용 서버(요구사항2.md §12).
const SECURE_URL = "https://127.0.0.1:4443";

export default defineConfig({
  testDir: "./tests",
  // 부트스트랩 계정의 강제 비밀번호 변경을 한 번 끝내 놓고 시작한다(요구사항2.md §2.4).
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    {
      name: "http",
      testIgnore: /secure-.*\.spec\.ts/,
      use: { baseURL: BASE_URL, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
    },
    {
      name: "secure",
      testMatch: /secure-.*\.spec\.ts/,
      use: {
        baseURL: SECURE_URL,
        // 로컬 자체 서명 인증서라 신뢰 체인이 없다 — TLS 자체가 아니라
        // "HTTPS 위에서 Secure 쿠키로 핵심 흐름이 도는가"가 검증 대상이다.
        ignoreHTTPSErrors: true,
        trace: "retain-on-failure",
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: [
    {
      command: "npm run e2e:server",
      cwd: "..",
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run e2e:server:secure",
      cwd: "..",
      url: `${SECURE_URL}/healthz`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
