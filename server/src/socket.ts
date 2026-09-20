import { parse as parseCookie } from "cookie";
import cookieParser from "cookie-parser";
import type { Server as HttpServer } from "node:http";
import type { SessionData } from "express-session";
import { Server } from "socket.io";
import { prisma } from "./prisma.js";
import { env, isProduction } from "./env.js";
import { appEvents, RealtimeEvent } from "./realtime.js";
import { CUSTOMER_SESSION_COOKIE, resolveCustomerSession } from "./services/customerSession.js";
import type { StaffRole } from "./types/domain.js";

const STAFF_COOKIE_NAME = "boardbite.sid";

type StaffRoom = "admin" | "front" | "pos" | "serving";

function roomForRole(role: StaffRole): StaffRoom {
  return role.toLowerCase() as StaffRoom;
}

/**
 * handshake 쿠키에서 직원 세션을 복원한다.
 *
 * express-session이 발급한 `boardbite.sid`는 `s:<sid>.<HMAC>` 형태로 서명되어 있으므로,
 * Express와 **동일한 SESSION_SECRET으로 서명을 검증한 뒤** 같은 store(StaffSession 테이블)를
 * 조회한다. 그리고 세션에 담긴 authVersion을 DB의 현재 값과 대조한다 —
 * 역할 변경/비활성화 직후의 낡은 세션은 소켓에서도 그대로 거부된다(요구사항2.md §2.1, §2.3).
 */
async function resolveStaffFromCookies(cookies: Record<string, string | undefined>) {
  const rawCookie = cookies[STAFF_COOKIE_NAME];
  if (!rawCookie) return null;

  const sid = cookieParser.signedCookie(decodeURIComponent(rawCookie), env.SESSION_SECRET);
  if (!sid || sid === rawCookie) {
    // 서명이 없거나 유효하지 않다 — 클라이언트가 임의로 만든 쿠키일 수 있으므로 거부한다.
    return null;
  }

  const row = await prisma.staffSession.findUnique({ where: { sid } });
  if (!row || row.expiresAt < new Date()) return null;

  let data: SessionData;
  try {
    data = JSON.parse(row.data) as SessionData;
  } catch {
    return null;
  }
  if (!data.staffUserId) return null;

  const user = await prisma.staffUser.findUnique({ where: { id: data.staffUserId } });
  if (!user || !user.isActive) return null;
  if (data.authVersion !== user.authVersion) return null;
  // 비밀번호 변경이 강제된 계정은 아직 정상 업무 세션이 아니다.
  if (user.mustResetPassword) return null;
  // REST의 requireOnboardingComplete와 같은 기준을 적용한다 — production에서 MFA를 아직
  // 설정하지 않은 ADMIN은 업무 API가 전부 403이므로, 실시간 이벤트도 받아서는 안 된다.
  if (isProduction && user.role === "ADMIN" && !user.mfaEnabled) return null;

  // 클라이언트가 보내는 값이 아니라 DB의 현재 role만 사용한다.
  return { id: user.id, role: user.role as StaffRole };
}

/**
 * docs/adr/0002-realtime-communication.md — room 기반 브로드캐스트.
 * 소켓 이벤트는 트리거일 뿐이며, 클라이언트는 재연결 시 항상 REST로 상태를 재조회해야 한다.
 */
export function attachSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, { cors: { origin: false } });

  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      const cookies = cookieHeader ? parseCookie(cookieHeader) : {};

      // 손님 기기 세션 — publicSlug가 아니라 join code로 발급된 device token만 인정한다.
      const customerToken = cookies[CUSTOMER_SESSION_COOKIE];
      if (customerToken) {
        const resolved = await resolveCustomerSession(customerToken);
        if (resolved) {
          socket.data.tableSessionId = resolved.tableSessionId;
        }
      }

      // 직원 세션 — 서버가 쿠키를 검증해 role을 정하고, 클라이언트는 room을 고를 수 없다.
      const staff = await resolveStaffFromCookies(cookies);
      if (staff) {
        socket.data.staffUserId = staff.id;
        socket.data.staffRole = staff.role;
      }
      next();
    } catch (err) {
      // 인증 확인 중 오류가 나면 "권한 없는 연결"로 다룬다(연결 자체는 허용해 손님 화면이 멈추지 않게).
      // eslint-disable-next-line no-console
      console.error("[socket] handshake 인증 처리 실패", err);
      next();
    }
  });

  io.on("connection", (socket) => {
    if (socket.data.tableSessionId) {
      socket.join(`table:${socket.data.tableSessionId}`);
    }

    // 직원 room 입장은 전적으로 서버가 결정한다. 클라이언트가 보내던 `staff:join(role)`은
    // 더 이상 존재하지 않으므로, 미인증 소켓은 어떤 직원 room에도 들어갈 수 없다.
    const role = socket.data.staffRole as StaffRole | undefined;
    if (role) {
      socket.join(`staff:${roomForRole(role)}`);
      // ADMIN은 모든 운영 화면을 볼 수 있어야 하므로 하위 room도 함께 구독한다
      // (REST 인가는 별도로 requireRole이 다시 검사한다).
      if (role === "ADMIN") {
        for (const sub of ["front", "pos", "serving"] as const) socket.join(`staff:${sub}`);
      }
      socket.emit("staff:joined", { role });
    }
  });

  appEvents.on(RealtimeEvent.OrderCreated, ({ tableSessionId }: { tableSessionId: string }) => {
    io.to(`table:${tableSessionId}`).emit(RealtimeEvent.OrderCreated, { tableSessionId });
    io.to("staff:pos").emit(RealtimeEvent.OrderCreated, { tableSessionId });
    io.to("staff:front").emit(RealtimeEvent.OrderCreated, { tableSessionId });
  });

  appEvents.on(RealtimeEvent.OrderStatusChanged, (payload: { tableSessionId: string; orderId: string; status: string }) => {
    io.to(`table:${payload.tableSessionId}`).emit(RealtimeEvent.OrderStatusChanged, payload);
    io.to("staff:pos").emit(RealtimeEvent.OrderStatusChanged, payload);
    io.to("staff:serving").emit(RealtimeEvent.OrderStatusChanged, payload);
    io.to("staff:front").emit(RealtimeEvent.OrderStatusChanged, payload);
  });

  appEvents.on(RealtimeEvent.TableOpened, (payload: { tableId: string; tableSessionId: string }) => {
    io.to("staff:front").emit(RealtimeEvent.TableOpened, payload);
  });

  appEvents.on(RealtimeEvent.TableClosed, (payload: { tableId: string; tableSessionId: string }) => {
    io.to(`table:${payload.tableSessionId}`).emit(RealtimeEvent.TableClosed, payload);
    io.to("staff:front").emit(RealtimeEvent.TableClosed, payload);
  });

  appEvents.on(RealtimeEvent.PaymentRecorded, (payload: { tableSessionId: string }) => {
    io.to(`table:${payload.tableSessionId}`).emit(RealtimeEvent.PaymentRecorded, payload);
    io.to("staff:front").emit(RealtimeEvent.PaymentRecorded, payload);
  });

  appEvents.on(RealtimeEvent.StaffCallRequested, (payload: { tableSessionId: string }) => {
    io.to("staff:serving").emit(RealtimeEvent.StaffCallRequested, payload);
    io.to("staff:front").emit(RealtimeEvent.StaffCallRequested, payload);
  });

  return io;
}
