// Prisma는 SQLite에서 enum을 지원하지 않아 String 컬럼으로 저장한다(prisma/schema.prisma 주석 참고).
// 애플리케이션 레벨에서 사용하는 리터럴 유니온 타입을 여기에 모아 재사용한다.

export type StaffRole = "ADMIN" | "FRONT" | "POS" | "SERVING";
export type TableStatus = "DISABLED" | "AVAILABLE" | "OPEN" | "SETTLING";
export type TableSessionStatus = "ACTIVE" | "CLOSED" | "EXPIRED";
export type OrderStatus = "NEW" | "ACCEPTED" | "PREPARING" | "READY" | "SERVED" | "REJECTED" | "CANCELLED";
export type PaymentKind = "CHARGE" | "VOID" | "REFUND";

export function asStaffRole(value: string): StaffRole {
  return value as StaffRole;
}
