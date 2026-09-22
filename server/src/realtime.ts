import { EventEmitter } from "node:events";

/**
 * 비즈니스 로직(services/routes)과 Socket.IO 전송 계층을 분리하기 위한 내부 이벤트 버스.
 * docs/adr/0002-realtime-communication.md — index.ts가 이 이벤트를 구독해 해당 room에 emit한다.
 */
export const appEvents = new EventEmitter();

export const RealtimeEvent = {
  OrderCreated: "order:created",
  OrderStatusChanged: "order:status-changed",
  TableOpened: "table:opened",
  TableClosed: "table:closed",
  PaymentRecorded: "payment:recorded",
  StaffCallRequested: "staff-call:requested",
  /** FRONT 현장 거래 확정/수령/취소 — 거래 목록과 KDS가 다시 조회할 시점을 알린다. */
  CounterSaleRecorded: "counter-sale:recorded",
  /**
   * 판매 가능 상태(품절/재개) 변경. 손님 메뉴·FRONT 현장 결제·주방·관리자 화면이
   * 이 신호를 받으면 목록을 다시 읽는다. 값을 실어 보내지 않고 "다시 조회하라"는 트리거로만 쓴다
   * (Socket.IO는 at-most-once라 값 자체를 신뢰할 수 없다 — 요구사항.md §11).
   */
  MenuAvailabilityChanged: "menu:availability-changed",
} as const;
