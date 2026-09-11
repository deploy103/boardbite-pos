import { parse as parseCookie } from "cookie";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { prisma } from "./prisma.js";
import { appEvents, RealtimeEvent } from "./realtime.js";
import { TABLE_SESSION_COOKIE } from "./middleware/requireTableSession.js";

/**
 * docs/adr/0002-realtime-communication.md — room 기반 브로드캐스트.
 * 소켓 이벤트는 트리거일 뿐이며, 클라이언트는 재연결 시 항상 REST로 상태를 재조회해야 한다.
 */
export function attachSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, { cors: { origin: false } });

  io.use(async (socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const cookies = cookieHeader ? parseCookie(cookieHeader) : {};

    const tableToken = cookies[TABLE_SESSION_COOKIE];
    if (tableToken) {
      const session = await prisma.tableSession.findUnique({ where: { token: tableToken } });
      if (session && session.status === "ACTIVE") {
        socket.data.tableSessionId = session.id;
      }
    }

    const sid = cookies["boardbite.sid"];
    if (sid) {
      // express-session 쿠키는 signed(`s:` 접두)이므로 sid만 room 매핑용으로 참고하고,
      // 실제 역할 정보는 별도 REST(/api/staff/me)로 클라이언트가 확인한다.
      socket.data.hasStaffCookie = true;
    }

    next();
  });

  io.on("connection", (socket) => {
    if (socket.data.tableSessionId) {
      socket.join(`table:${socket.data.tableSessionId}`);
    }

    socket.on("staff:join", (role: string) => {
      if (["pos", "serving", "front", "admin"].includes(role)) {
        socket.join(`staff:${role}`);
      }
    });
  });

  appEvents.on(RealtimeEvent.OrderCreated, ({ tableSessionId }: { tableSessionId: string }) => {
    io.to(`table:${tableSessionId}`).emit(RealtimeEvent.OrderCreated, { tableSessionId });
    io.to("staff:pos").emit(RealtimeEvent.OrderCreated, { tableSessionId });
  });

  appEvents.on(RealtimeEvent.OrderStatusChanged, (payload: { tableSessionId: string; orderId: string; status: string }) => {
    io.to(`table:${payload.tableSessionId}`).emit(RealtimeEvent.OrderStatusChanged, payload);
    io.to("staff:pos").emit(RealtimeEvent.OrderStatusChanged, payload);
    io.to("staff:serving").emit(RealtimeEvent.OrderStatusChanged, payload);
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
  });

  return io;
}
