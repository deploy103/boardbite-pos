import { useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import PaymentMethodPicker from "./PaymentMethodPicker.js";
import CashQuickAmount from "./CashQuickAmount.js";
import { formatWon } from "./format.js";
import type { OrderRow, PaymentMethod, Settlement } from "./types.js";

interface FlatItem {
  orderId: string;
  id: string;
  nameSnapshot: string;
  unitPrice: number;
  options: { id: string; nameSnapshot: string; extraPriceSnapshot: number }[];
  paidQuantity: number;
  remainingQuantity: number;
}

function lineUnitPrice(item: FlatItem) {
  return item.unitPrice + item.options.reduce((sum, opt) => sum + opt.extraPriceSnapshot, 0);
}

/**
 * "상품별 결제" 탭 — 요구사항.md §12.6. remainingQuantity까지만 선택 가능하고,
 * REJECTED 주문은 애초에 목록에서 제외한다(서버도 400으로 거부하지만 UX상 선택 자체를 막는다).
 */
export default function ItemSplitPanel({
  tableSessionId,
  methods,
  orders,
  onSubmitted,
  onError,
}: {
  tableSessionId: string;
  methods: PaymentMethod[];
  orders: OrderRow[];
  onSubmitted: (settlement: Settlement) => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [methodCode, setMethodCode] = useState<string | null>(methods[0]?.code ?? null);
  const [tendered, setTendered] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const payableItems = useMemo<FlatItem[]>(
    () =>
      orders
        .filter((o) => o.status !== "REJECTED")
        .flatMap((o) => o.items.map((item) => ({ orderId: o.id, ...item }))),
    [orders],
  );

  const totalSelected = payableItems.reduce((sum, item) => {
    const qty = selected[item.id] ?? 0;
    return sum + qty * lineUnitPrice(item);
  }, 0);

  const selectedMethod = methods.find((m) => m.code === methodCode) ?? null;
  const hasSelection = totalSelected > 0;
  const canSubmit =
    !submitting && hasSelection && selectedMethod !== null && (!selectedMethod.isCash || tendered >= totalSelected);

  function setQty(itemId: string, qty: number, max: number) {
    const clamped = Math.max(0, Math.min(qty, max));
    setSelected((prev) => ({ ...prev, [itemId]: clamped }));
  }

  async function submit() {
    if (!selectedMethod) return;
    const allocations = Object.entries(selected)
      .filter(([, qty]) => qty > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    if (allocations.length === 0) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        idempotencyKey: crypto.randomUUID(),
        methodCode: selectedMethod.code,
        mode: "ITEMS",
        allocations,
      };
      if (selectedMethod.isCash) {
        body.tenderedAmount = tendered;
      }
      const result = await api.post(`/api/staff/front/table-sessions/${tableSessionId}/payments`, body);
      setSelected({});
      setTendered(0);
      onSubmitted(result.settlement);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "결제 처리 중 오류가 발생했어요.");
    } finally {
      setSubmitting(false);
    }
  }

  if (payableItems.length === 0 || payableItems.every((item) => item.remainingQuantity === 0)) {
    return <p className="text-muted">결제할 수 있는 상품이 없어요.</p>;
  }

  return (
    <div className="checkout-panel">
      <ul className="checkout-item-list">
        {payableItems.map((item) => {
          const qty = selected[item.id] ?? 0;
          const disabled = item.remainingQuantity === 0;
          return (
            <li key={item.id} className={`checkout-item-row${disabled ? " checkout-item-row--disabled" : ""}`}>
              <div>
                <div className="checkout-item-row__name">{item.nameSnapshot}</div>
                {item.options.length > 0 && (
                  <div className="text-muted">{item.options.map((o) => o.nameSnapshot).join(", ")}</div>
                )}
                <div className="text-muted">
                  {formatWon(lineUnitPrice(item))}
                  {disabled ? " · 결제 완료" : ` · 결제 가능 ${item.remainingQuantity}개`}
                  {item.paidQuantity > 0 && !disabled && ` (이미 ${item.paidQuantity}개 결제됨)`}
                </div>
              </div>
              <div className="qty-stepper">
                <button
                  type="button"
                  className="qty-btn"
                  disabled={disabled || qty <= 0}
                  onClick={() => setQty(item.id, qty - 1, item.remainingQuantity)}
                >
                  −
                </button>
                <span className="qty-value">{qty}</span>
                <button
                  type="button"
                  className="qty-btn"
                  disabled={disabled || qty >= item.remainingQuantity}
                  onClick={() => setQty(item.id, qty + 1, item.remainingQuantity)}
                >
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="checkout-item-total">
        <span>선택한 합계</span>
        <strong>{formatWon(totalSelected)}</strong>
      </div>
      {hasSelection && (
        <>
          <PaymentMethodPicker methods={methods} selectedCode={methodCode} onSelect={setMethodCode} />
          {selectedMethod?.isCash && (
            <CashQuickAmount targetAmount={totalSelected} tendered={tendered} onChange={setTendered} />
          )}
        </>
      )}
      <button className="btn-primary checkout-submit-btn" disabled={!canSubmit} onClick={submit}>
        {submitting ? "처리 중이에요..." : "선택한 상품 결제하기"}
      </button>
    </div>
  );
}
