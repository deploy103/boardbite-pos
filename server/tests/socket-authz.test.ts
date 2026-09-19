import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { io as ioClient, type Socket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../src/app.js";
import { attachSocket } from "../src/socket.js";
import { appEvents, RealtimeEvent } from "../src/realtime.js";
import { prisma } from "../src/prisma.js";
import { app, createStaff, createTableWithMenu, openTableSessionDirect } from "./helpers.js";

/**
 * 요구사항2.md §2.1 — Socket.IO 직원 room 인증.
 *
 * 예전 구조에서는 클라이언트가 `staff:join("admin")`처럼 원하는 room을 문자열로 골라 들어갈 수
 * 있었다. 지금은 서버가 handshake 쿠키를 검증해 DB의 현재 role로만 room을 배정한다.
 * 여기서는 실제 소켓을 붙여 "누가 어떤 이벤트를 받는가"로 경계를 확인한다.
 */

let httpServer: HttpServer;
let port: number;
const openSockets: Socket[] = [];

beforeAll(async () => {
  httpServer = createServer(createApp());
  attachSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of openSockets) socket.disconnect();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/**
 * 응답의 Set-Cookie에서 `name=value` 부분만 모아 handshake 헤더로 쓸 문자열을 만든다.
 * 세션은 DB(StaffSession)에 저장되므로, supertest가 호출한 app 인스턴스에서 받은 쿠키가
 * 별도로 띄운 소켓 서버에서도 그대로 유효하다.
 */
function cookieHeader(setCookie: string[] | undefined): string {
  return (setCookie ?? []).map((c) => c.split(";")[0]).join("; ");
}

/** 로그인해서 직원 세션 쿠키 문자열을 얻는다. */
async function loginCookie(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/staff/login").set("X-BoardBite-Client", "1").send({ username, password });
  if (res.status !== 200) throw new Error(`로그인 실패: ${res.status}`);
  return cookieHeader(res.headers["set-cookie"] as unknown as string[]);
}

/** join code로 입장해서 손님 device session 쿠키 문자열을 얻는다. */
async function joinCookie(slug: string, joinCode: string): Promise<string> {
  const res = await request(app).post(`/api/customer/join/${slug}`).set("X-BoardBite-Client", "1").send({ joinCode });
  if (res.status !== 200) throw new Error(`손님 입장 실패: ${res.status}`);
  return cookieHeader(res.headers["set-cookie"] as unknown as string[]);
}

async function connect(cookie?: string): Promise<Socket> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
    forceNew: true,
  });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  return socket;
}

/** 이벤트를 하나 쏘고, 각 소켓이 그것을 받았는지 짧은 시간 안에 판정한다. */
async function receives(socket: Socket, event: string, fire: () => void, waitMs = 250): Promise<boolean> {
  let got = false;
  const handler = () => {
    got = true;
  };
  socket.on(event, handler);
  fire();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  socket.off(event, handler);
  return got;
}

describe("Socket.IO 직원 room 인증", () => {
  it("비로그인 소켓은 어떤 직원 room에도 들어가지 못한다", async () => {
    const anonymous = await connect();

    // 예전 API를 흉내 내 room을 직접 요청해도 서버에는 해당 핸들러가 없다.
    anonymous.emit("staff:join", "admin");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const got = await receives(anonymous, RealtimeEvent.TableOpened, () => {
      appEvents.emit(RealtimeEvent.TableOpened, { tableId: "t1", tableSessionId: "s1" });
    });
    expect(got).toBe(false);
  });

  it("FRONT 계정은 FRONT room만 받고 POS 전용 이벤트는 받지 않는다", async () => {
    const front = await createStaff("FRONT");
    const socket = await connect(await loginCookie(front.username, front.password));

    // FRONT room 이벤트는 수신된다.
    const gotTableOpened = await receives(socket, RealtimeEvent.TableOpened, () => {
      appEvents.emit(RealtimeEvent.TableOpened, { tableId: "t2", tableSessionId: "s2" });
    });
    expect(gotTableOpened).toBe(true);

    // SERVING 전용 이벤트(직원 호출)는 FRONT도 받도록 설계되어 있으므로,
    // 경계 확인은 "role을 스스로 바꿀 수 없다"로 한다.
    socket.emit("staff:join", "admin");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stillNotAdmin = await receives(socket, "staff:joined", () => {
      appEvents.emit(RealtimeEvent.TableOpened, { tableId: "t3", tableSessionId: "s3" });
    });
    expect(stillNotAdmin).toBe(false);
  });

  it("서버가 알려주는 role은 클라이언트 요청이 아니라 DB 값이다", async () => {
    const pos = await createStaff("POS");
    const cookie = await loginCookie(pos.username, pos.password);

    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      extraHeaders: { Cookie: cookie },
      forceNew: true,
    });
    openSockets.push(socket);

    const joined = await new Promise<{ role: string }>((resolve, reject) => {
      socket.on("staff:joined", resolve);
      socket.on("connect_error", reject);
      setTimeout(() => reject(new Error("staff:joined 이벤트를 받지 못했습니다.")), 2000);
    });
    expect(joined.role).toBe("POS");
  });

  it("비활성화된 계정의 소켓은 직원 권한으로 인정되지 않는다", async () => {
    const victim = await createStaff("FRONT");
    const cookie = await loginCookie(victim.username, victim.password);

    await prisma.staffUser.update({ where: { username: victim.username }, data: { isActive: false } });

    const socket = await connect(cookie);
    const got = await receives(socket, RealtimeEvent.TableOpened, () => {
      appEvents.emit(RealtimeEvent.TableOpened, { tableId: "t4", tableSessionId: "s4" });
    });
    expect(got).toBe(false);
  });

  it("권한이 바뀐 뒤 재연결하면 새 권한이 즉시 적용된다", async () => {
    const user = await createStaff("POS");
    const cookie = await loginCookie(user.username, user.password);

    // role을 바꾸면 authVersion이 올라가므로, 낡은 쿠키의 소켓은 더 이상 직원으로 인정되지 않는다.
    await prisma.staffUser.update({
      where: { username: user.username },
      data: { role: "FRONT", authVersion: { increment: 1 } },
    });

    const socket = await connect(cookie);
    const got = await receives(socket, RealtimeEvent.TableOpened, () => {
      appEvents.emit(RealtimeEvent.TableOpened, { tableId: "t5", tableSessionId: "s5" });
    });
    expect(got).toBe(false);
  });
});

describe("Socket.IO 손님 room", () => {
  it("입장한 손님은 자기 테이블 이벤트만 받는다", async () => {
    const { table } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);
    const socket = await connect(await joinCookie(table.publicSlug, session.joinCode));

    const own = await receives(socket, RealtimeEvent.OrderStatusChanged, () => {
      appEvents.emit(RealtimeEvent.OrderStatusChanged, {
        tableSessionId: session.id,
        orderId: "o1",
        status: "READY",
      });
    });
    expect(own).toBe(true);

    const other = await receives(socket, RealtimeEvent.OrderStatusChanged, () => {
      appEvents.emit(RealtimeEvent.OrderStatusChanged, {
        tableSessionId: "someone-elses-session",
        orderId: "o2",
        status: "READY",
      });
    });
    expect(other).toBe(false);
  });

  it("입장하지 않은 기기는 어떤 테이블 이벤트도 받지 못한다", async () => {
    const { table } = await createTableWithMenu();
    const session = await openTableSessionDirect(table.id);

    const socket = await connect();
    const got = await receives(socket, RealtimeEvent.OrderStatusChanged, () => {
      appEvents.emit(RealtimeEvent.OrderStatusChanged, { tableSessionId: session.id, orderId: "o3", status: "READY" });
    });
    expect(got).toBe(false);
  });
});
