import { createServer } from "node:http";
import { env, assertProductionEnv } from "./env.js";
import { createApp } from "./app.js";
import { attachSocket } from "./socket.js";
import { cleanupAuthArtifacts } from "./services/staffAccount.js";
import { cleanupExpiredDeviceSessions } from "./services/customerSession.js";

// 잘못된 secret/기본 비밀번호로 production이 기동되는 것을 여기서 끊는다(요구사항2.md §7.3).
// 실패 메시지에는 어떤 항목이 문제인지만 담기고 실제 값은 절대 출력되지 않는다.
assertProductionEnv();

const app = createApp();
const httpServer = createServer(app);
attachSocket(httpServer);

/**
 * 만료된 인증 흔적 정리(요구사항2.md §4.1).
 * 오래된 LoginAttempt / 만료 StaffSession / 만료·revoke된 CustomerDeviceSession을 주기적으로 지운다.
 * 축제 하루 운영 기준으로 1시간 주기면 충분하고, 부팅 직후 한 번 먼저 돌린다.
 */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

async function runMaintenance() {
  try {
    const auth = await cleanupAuthArtifacts();
    const deviceSessions = await cleanupExpiredDeviceSessions();
    // eslint-disable-next-line no-console
    console.log(
      `[maintenance] loginAttempts=${auth.loginAttempts} staffSessions=${auth.staffSessions} customerDeviceSessions=${deviceSessions}`,
    );
  } catch (err) {
    // 정리 실패가 서비스 중단으로 번지지 않게 한다.
    // eslint-disable-next-line no-console
    console.error("[maintenance] 정리 작업 실패", err);
  }
}

const maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
// 정리 작업 때문에 프로세스가 종료되지 못하는 일이 없도록 unref 한다.
maintenanceTimer.unref();

httpServer.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`BoardBite POS server listening on port ${env.PORT} (${env.NODE_ENV})`);
  void runMaintenance();
});
