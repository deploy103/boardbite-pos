// FRONT 현장 결제 화면이 공유하는 타입.
// 서버: server/src/services/counterSale.ts (quoteCounterSale / getCounterSaleDetail), coupon.ts

import type { MenuItem } from "../customer/types.js";

/** 현장 판매 메뉴. 옵션 구조는 손님 화면과 동일하므로 OptionSheet를 그대로 재사용한다. */
export interface CounterMenuItem extends MenuItem {
  channel: "TABLE" | "FRONT" | "BOTH";
  needsCooking: boolean;
  showInKitchen: boolean;
  /** 필수 그룹에 고를 선택지가 없어 지금은 팔 수 없는 메뉴. 담기 버튼을 막는 근거다. */
  blockedRequiredGroups: string[];
}

export interface CounterMenuCategory {
  id: string;
  name: string;
  items: CounterMenuItem[];
}

/** 장바구니 한 줄. 같은 메뉴라도 옵션 조합이 다르면 별도 행이다. */
export interface CounterCartLine {
  key: string;
  item: CounterMenuItem;
  quantity: number;
  optionChoiceIds: string[];
}

export interface QuoteLine {
  index: number;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  servingMode: "KITCHEN" | "COUNTER";
  options: { optionChoiceId: string; groupNameSnapshot: string; nameSnapshot: string; extraPriceSnapshot: number }[];
  lineTotal: number;
  discountAmount: number;
}

export interface CounterQuote {
  lines: QuoteLine[];
  subtotal: number;
  discountAmount: number;
  totalAmount: number;
  coupon: {
    code: string;
    type: "AMOUNT" | "ITEM";
    benefitLabel: string;
    discountAmount: number;
    targetLineIndex: number | null;
    targetMenuItemId: string | null;
  } | null;
  hasKitchenItems: boolean;
  hasCounterItems: boolean;
  quoteHash: string;
}

export interface CouponLookup {
  code: string;
  state: "AVAILABLE" | "USED" | "EXPIRED" | "CANCELLED";
  stateLabel: string;
  benefitLabel: string;
  benefit: { type: "AMOUNT" | "ITEM"; amount: number | null; targets: { menuItemId: string; nameSnapshot: string }[] };
  expiresAt: string | null;
  usableTargets: { menuItemId: string; name: string; price: number; isSoldOut: boolean }[];
  targetsUnavailable: boolean;
}

export interface CounterSaleOrderItem {
  id: string;
  nameSnapshot: string;
  unitPrice: number;
  quantity: number;
  servingMode: "KITCHEN" | "COUNTER";
  options: { id: string; groupNameSnapshot: string | null; nameSnapshot: string; extraPriceSnapshot: number }[];
}

export interface CounterSaleOrder {
  id: string;
  status: string;
  servingMode: "KITCHEN" | "COUNTER";
  createdAt: string;
  readyAt: string | null;
  servedAt: string | null;
  cancelReason: string | null;
  rejectReason: string | null;
  items: CounterSaleOrderItem[];
}

export interface CounterSaleDetail {
  id: string;
  saleNo: number;
  status: "COMPLETED" | "CANCELLED";
  createdAt: string;
  createdBy: { id: string; displayName: string };
  cancelledAt: string | null;
  cancelledBy: { id: string; displayName: string } | null;
  cancelReason: string | null;
  orders: CounterSaleOrder[];
  payments: {
    id: string;
    kind: "CHARGE" | "DISCOUNT" | "VOID" | "REFUND";
    method: string;
    amount: number;
    tenderedAmount: number | null;
    changeAmount: number | null;
    reason: string | null;
    createdAt: string;
    createdBy: { displayName: string };
  }[];
  coupon: {
    code: string;
    type: "AMOUNT" | "ITEM";
    benefitLabel: string;
    discountAmount: number;
    originalAmount: number;
    redeemedAt: string;
    cancelledAt: string | null;
  } | null;
  ledger: {
    orderAmount: number;
    discountAmount: number;
    couponDiscountAmount: number;
    grossChargedAmount: number;
    refundedAmount: number;
    netChargedAmount: number;
    remainingAmount: number;
  };
  pickupPending: boolean;
  refundNeeded: boolean;
}

/** 같은 메뉴 + 같은 옵션 조합이면 한 줄로 합친다(옵션 순서는 무시). */
export function counterLineKey(menuItemId: string, optionChoiceIds: string[]): string {
  return `${menuItemId}::${[...optionChoiceIds].sort().join(",")}`;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  NEW: "주방 접수 대기",
  ACCEPTED: "주방 접수됨",
  PREPARING: "조리 중",
  READY: "조리 완료 · 수령 대기",
  SERVED: "제공 완료",
  REJECTED: "주방 거절",
  CANCELLED: "취소됨",
};
