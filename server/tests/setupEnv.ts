import { TEST_DATABASE_URL } from "./testDbPath.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";
process.env.ADMINID = "admin";
process.env.ADMINPASSWORD = "admin-test-pw-12345678";
// FRONT/POS/SERVING 계정은 더 이상 환경변수로 시드되지 않는다.
// 테스트는 helpers.ts의 createStaff()로 필요한 역할 계정을 직접 만든다.
process.env.NODE_ENV = "test";
process.env.PORT = "3999"; // 테스트는 supertest로 앱 인스턴스를 직접 호출하므로 실제로 listen하지 않음
// 전체 스위트가 한 IP에서 손님 API를 수백 번 호출하므로 일반 손님 rate limit은 넉넉히 잡는다.
// join code 무차별 대입 제한(테이블별 10회/10분)은 앱에 고정되어 있어 그대로 검증된다.
process.env.CUSTOMER_RATE_LIMIT_PER_MIN = "100000";
// 한 스위트에서 수백 번 로그인하므로 IP 단위 1차 제한은 풀어둔다.
// 실제 brute force 방어(loginGuard: 계정+IP 조합, 지수 backoff)는 login-guard.test.ts에서 그대로 검증한다.
process.env.STAFF_LOGIN_RATE_LIMIT_PER_5MIN = "100000";
// MFA/step-up 계열도 마찬가지 — 실제 차단선인 "세션 단위 실패 카운터"는 이 값과 무관하게
// 그대로 동작하고, staff-session.test.ts가 그 동작을 직접 검증한다.
process.env.SENSITIVE_AUTH_RATE_LIMIT_PER_10MIN = "100000";
