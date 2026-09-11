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
} as const;
