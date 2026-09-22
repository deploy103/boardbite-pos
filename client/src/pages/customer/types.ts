// 고객 주문 화면에서 공유하는 타입/헬퍼.
// 서버 스키마 참고: server/prisma/schema.prisma (MenuItem/OptionGroup/OptionChoice/Order/OrderItem)

export interface OptionChoice {
  id: string;
  name: string;
  extraPrice: number;
  /** 연결된 재고 품목이 품절이면 true. 보이기는 하지만 고를 수 없다. */
  isSoldOut?: boolean;
  /** 무엇 때문에 품절인지(연결된 메뉴 이름). 화면이 "계란 품절"처럼 안내한다. */
  soldOutReason?: string | null;
}

export interface OptionGroup {
  id: string;
  name: string;
  /** 최소 선택 개수(0이면 선택 사항). */
  minSelect: number;
  /** 최대 선택 개수. null이면 제한 없음. */
  maxSelect: number | null;
  /** 서버가 minSelect/maxSelect에서 파생해 내려주는 값 — 화면이 다시 계산하지 않는다. */
  required: boolean;
  multiSelect: boolean;
  /** "필수", "1~2개", "최대 3개" 같은 사람이 읽는 규칙 문구. */
  selectRangeLabel: string;
  choices: OptionChoice[];
}

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  description: string | null;
  /** 공용 물품 연결까지 반영한 최종 품절 상태(서버가 계산해 내려준다). */
  isSoldOut: boolean;
  /** 어떤 공용 물품 때문에 품절인지. 연결이 없으면 null. */
  soldOutReason?: string | null;
  optionGroups: OptionGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  items: MenuItem[];
}

export interface CartLine {
  id: string;
  menuItem: MenuItem;
  quantity: number;
  optionChoiceIds: string[];
}

export interface OrderItemOption {
  id: string;
  groupNameSnapshot: string | null;
  nameSnapshot: string;
  extraPriceSnapshot: number;
}

export interface OrderItem {
  id: string;
  nameSnapshot: string;
  unitPrice: number;
  quantity: number;
  options: OrderItemOption[];
}

export interface Order {
  id: string;
  status: string;
  note: string | null;
  rejectReason: string | null;
  cancelReason: string | null;
  createdAt: string;
  items: OrderItem[];
}

export interface Bill {
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

export function allChoicesOf(item: MenuItem): OptionChoice[] {
  return item.optionGroups.flatMap((group) => group.choices);
}

export function lineUnitPrice(line: CartLine): number {
  const choices = allChoicesOf(line.menuItem);
  const optionsSum = line.optionChoiceIds.reduce((sum, id) => {
    const choice = choices.find((c) => c.id === id);
    return sum + (choice?.extraPrice ?? 0);
  }, 0);
  return line.menuItem.price + optionsSum;
}

/**
 * 주문 내역 한 줄의 실제 청구 금액(요구사항2.md §10.1).
 *
 * 서버는 (단가 + 옵션 추가금) × 수량으로 청구하는데 화면이 unitPrice만 곱하면
 * 옵션 금액이 통째로 빠져 보인다 — 손님이 보는 금액과 실제 결제 금액이 달라지는 버그였다.
 */
export function orderItemLineTotal(item: OrderItem): number {
  const optionsSum = item.options.reduce((sum, option) => sum + option.extraPriceSnapshot, 0);
  return (item.unitPrice + optionsSum) * item.quantity;
}

export function lineOptionNames(line: CartLine): string[] {
  const choices = allChoicesOf(line.menuItem);
  return line.optionChoiceIds
    .map((id) => choices.find((c) => c.id === id)?.name)
    .filter((name): name is string => Boolean(name));
}

// 같은 메뉴 + 같은 옵션 조합이면 장바구니에서 한 줄로 합친다 (옵션 순서는 무시).
export function cartLineKey(menuItemId: string, optionChoiceIds: string[]): string {
  return `${menuItemId}::${[...optionChoiceIds].sort().join(",")}`;
}

export const ORDER_STATUS_STEPS = [
  { key: "NEW", label: "주문 확인 중" },
  { key: "ACCEPTED", label: "주문 접수" },
  { key: "PREPARING", label: "조리 중" },
  { key: "READY", label: "준비 완료" },
  { key: "SERVED", label: "서빙 완료" },
] as const;

// server/src/realtime.ts의 RealtimeEvent 문자열과 동기화되어야 한다 (서버 파일은 직접 import하지 않는다).
export const REALTIME_EVENTS = {
  OrderCreated: "order:created",
  OrderStatusChanged: "order:status-changed",
  TableClosed: "table:closed",
  PaymentRecorded: "payment:recorded",
  /** 품절/판매 재개 — 손님 메뉴를 다시 읽어야 한다. */
  MenuAvailabilityChanged: "menu:availability-changed",
} as const;
