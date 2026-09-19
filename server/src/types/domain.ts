// Prisma는 SQLite에서 enum을 지원하지 않아 String 컬럼으로 저장한다(prisma/schema.prisma 주석 참고).
// 애플리케이션 레벨에서 사용하는 리터럴 유니온 타입을 여기에 모아 재사용한다.

export type StaffRole = "ADMIN" | "FRONT" | "POS" | "SERVING";
export type TableStatus = "DISABLED" | "AVAILABLE" | "OPEN" | "SETTLING";
export type TableSessionStatus = "ACTIVE" | "PAID_PENDING_SERVICE" | "CLOSED" | "EXPIRED";
export type OrderStatus = "NEW" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "REJECTED" | "CANCELLED";
export type PaymentKind = "CHARGE" | "DISCOUNT" | "VOID" | "REFUND";
export type StaffCallStatus = "PENDING" | "ACKED" | "DONE";

/** 아직 서빙되지 않아 "테이블을 정리하면 안 되는" 주문 상태들. */
export const ACTIVE_ORDER_STATUSES = ["NEW", "ACCEPTED", "PREPARING", "READY"] as const;

/** 손님이 접근할 수 있는 테이블 세션 상태. */
export const CUSTOMER_VISIBLE_SESSION_STATUSES = ["ACTIVE", "PAID_PENDING_SERVICE"] as const;

export function asStaffRole(value: string): StaffRole {
  return value as StaffRole;
}
