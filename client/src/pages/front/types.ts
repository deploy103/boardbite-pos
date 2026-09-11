// FRONT 정산 화면(client/src/pages/front/*)에서 공유하는 타입.
// server/prisma/schema.prisma의 Order/OrderItem/Payment/PaymentMethod와 1:1로 대응한다.
// server/src/services/billing.ts의 BillSummary, server/src/services/payment.ts의 CreatePaymentResult 참고.

export interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  isCash: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface OrderItemOption {
  id: string;
  nameSnapshot: string;
  extraPriceSnapshot: number;
}

export interface OrderItemRow {
  id: string;
  menuItemId: string;
  nameSnapshot: string;
  unitPrice: number;
  quantity: number;
  options: OrderItemOption[];
  paidQuantity: number;
  remainingQuantity: number;
}

export interface OrderRow {
  id: string;
  status: string;
  note: string | null;
  createdAt: string;
  items: OrderItemRow[];
}

export interface PaymentAllocationRow {
  id: string;
  orderItemId: string;
  quantity: number;
  amount: number;
}

export type PaymentKind = "CHARGE" | "DISCOUNT" | "VOID" | "REFUND";

export interface PaymentRow {
  id: string;
  kind: PaymentKind;
  method: string;
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number | null;
  payerLabel: string | null;
  reversedPaymentId: string | null;
  reason: string | null;
  createdAt: string;
  createdBy: { displayName: string };
  allocations: PaymentAllocationRow[];
}

export interface Bill {
  totalAmount: number;
  discountAmount: number;
  chargedAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

export interface CheckoutData {
  table: { id: string; number: number; paymentsLocked: boolean };
  session: { id: string; status: "ACTIVE" | "PAID_PENDING_SERVICE" };
  bill: Bill;
  orders: OrderRow[];
  payments: PaymentRow[];
}

// POST .../payments, .../discount, .../payments/:id/void 공통 응답의 settlement 필드.
export type Settlement = "CLOSED" | "PENDING_SERVICE" | "NO_CHANGE";
