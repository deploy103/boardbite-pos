import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { reportSocketState } from "./api.js";

/**
 * docs/adr/0002-realtime-communication.md — 소켓 이벤트는 트리거일 뿐이다.
 * 이벤트를 받으면 항상 REST로 다시 조회하도록 콜백에서 처리해야 한다(단일 진실 공급원은 서버 DB).
 *
 * 요구사항2.md §2.1: 직원 room은 서버가 세션 쿠키를 검증해 자동으로 배정한다.
 * 클라이언트가 room(=권한)을 고르던 `staff:join(role)` 호출은 제거되었다.
 */
export function useStaffSocket(onEvent: (event: string, payload: unknown) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const socket = io({ path: "/socket.io", withCredentials: true });

    socket.on("connect", () => reportSocketState(true));
    socket.on("disconnect", () => reportSocketState(false));
    socket.on("connect_error", () => reportSocketState(false));
    // 재연결되면 그 사이 놓친 변화가 있을 수 있으므로 화면이 전체를 다시 읽도록 신호를 보낸다.
    socket.on("staff:joined", () => handlerRef.current("staff:joined", null));

    const events = [
      "order:created",
      "order:status-changed",
      "table:opened",
      "table:closed",
      "payment:recorded",
      "staff-call:requested",
      // FRONT 현장 거래 확정/수령/취소 — 거래 목록과 KDS가 다시 조회하도록 알린다.
      "counter-sale:recorded",
    ];
    for (const ev of events) {
      socket.on(ev, (payload: unknown) => handlerRef.current(ev, payload));
    }

    return () => {
      socket.disconnect();
      reportSocketState(true); // 화면을 떠나는 것은 연결 장애가 아니다.
    };
  }, []);
}
