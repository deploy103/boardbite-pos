import { useEffect, useRef } from "react";
import { io } from "socket.io-client";

type StaffRoom = "pos" | "serving" | "front" | "admin";

/**
 * docs/adr/0002-realtime-communication.md — 소켓 이벤트는 트리거일 뿐이다.
 * 이벤트를 받으면 항상 REST로 다시 조회하도록 콜백에서 처리해야 한다(단일 진실 공급원은 서버 DB).
 */
export function useStaffSocket(room: StaffRoom, onEvent: (event: string, payload: unknown) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const socket = io({ path: "/socket.io", withCredentials: true });
    socket.on("connect", () => socket.emit("staff:join", room));

    const events = [
      "order:created",
      "order:status-changed",
      "table:opened",
      "table:closed",
      "payment:recorded",
      "staff-call:requested",
    ];
    for (const ev of events) {
      socket.on(ev, (payload: unknown) => handlerRef.current(ev, payload));
    }

    return () => {
      socket.disconnect();
    };
  }, [room]);
}
