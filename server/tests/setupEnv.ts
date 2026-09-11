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
