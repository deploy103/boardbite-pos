import { TEST_DATABASE_URL } from "./testDbPath.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-prod";
process.env.ADMINID = "admin";
process.env.ADMINPASSWORD = "admin-test-pw-12345678";
process.env.FRONTID = "front";
process.env.FRONTPW = "front-test-pw-12345678";
process.env.POSID = "pos";
process.env.POSPW = "pos-test-pw-12345678";
process.env.SERVING_ID = "serving";
process.env.SERVING_PW = "serving-test-pw-12345678";
process.env.NODE_ENV = "test";
process.env.PORT = "3999"; // 테스트는 supertest로 앱 인스턴스를 직접 호출하므로 실제로 listen하지 않음
// 전체 스위트가 한 IP에서 손님 API를 수백 번 호출하므로 일반 손님 rate limit은 넉넉히 잡는다.
// join code 무차별 대입 제한(테이블별 10회/10분)은 앱에 고정되어 있어 그대로 검증된다.
process.env.CUSTOMER_RATE_LIMIT_PER_MIN = "100000";
// 한 스위트에서 수백 번 로그인하므로 IP 단위 1차 제한은 풀어둔다.
// 실제 brute force 방어(loginGuard: 계정+IP 조합, 지수 backoff)는 login-guard.test.ts에서 그대로 검증한다.
process.env.STAFF_LOGIN_RATE_LIMIT_PER_5MIN = "100000";
