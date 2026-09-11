import { useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import PaymentMethodPicker from "./PaymentMethodPicker.js";
import CashQuickAmount from "./CashQuickAmount.js";
import { formatWon } from "./format.js";
import type { PaymentMethod, Settlement } from "./types.js";

/** "금액으로 결제" 탭 — 부분결제/복합결제 겸용(요구사항.md §12.3, §12.4). */
export default function AmountPaymentPanel({
  tableSessionId,
  methods,
  remainingAmount,
  onSubmitted,
  onError,
}: {
  tableSessionId: string;
  methods: PaymentMethod[];
  remainingAmount: number;
  onSubmitted: (settlement: Settlement) => void;
  onError: (message: string) => void;
}) {
  const owed = Math.max(remainingAmount, 0);
  const [methodCode, setMethodCode] = useState<string | null>(methods[0]?.code ?? null);
  const [amountText, setAmountText] = useState("");
  const [tendered, setTendered] = useState(owed);
  const [submitting, setSubmitting] = useState(false);

  const selectedMethod = methods.find((m) => m.code === methodCode) ?? null;
  const amount = Number(amountText) || 0;

  const canSubmit =
    !submitting &&
    owed > 0 &&
    selectedMethod !== null &&
    (selectedMethod.isCash ? tendered > 0 : amount > 0 && amount <= owed);

  async function submit() {
    if (!selectedMethod) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        idempotencyKey: crypto.randomUUID(),
        methodCode: selectedMethod.code,
        mode: "AMOUNT",
      };
      if (selectedMethod.isCash) {
        body.tenderedAmount = tendered;
      } else {
        body.amount = amount;
      }
      const result = await api.post(`/api/staff/front/table-sessions/${tableSessionId}/payments`, body);
      setAmountText("");
      setTendered(Math.max(result.bill.remainingAmount, 0));
      onSubmitted(result.settlement);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "결제 처리 중 오류가 발생했어요.");
    } finally {
      setSubmitting(false);
    }
  }

  if (owed <= 0) {
    return <p className="text-muted">남은 금액이 없어요. 결제를 진행할 필요가 없어요.</p>;
  }

  return (
    <div className="checkout-panel">
      <PaymentMethodPicker methods={methods} selectedCode={methodCode} onSelect={setMethodCode} />
      {selectedMethod?.isCash ? (
        <CashQuickAmount targetAmount={owed} capAmount={owed} tendered={tendered} onChange={setTendered} />
      ) : (
        <>
          <label className="checkout-field-label" htmlFor="checkout-amount-input">
            결제 금액 (남은 금액 {formatWon(owed)} 이하)
          </label>
          <input
            id="checkout-amount-input"
            className="field"
            type="number"
            min={1}
            max={owed}
            inputMode="numeric"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="결제 금액"
          />
          {amount > owed && (
            <p className="error-text">남은 금액을 초과해서 결제할 수 없어요. 초과 수납은 현금만 가능해요.</p>
          )}
        </>
      )}
      <button className="btn-primary checkout-submit-btn" disabled={!canSubmit} onClick={submit}>
        {submitting ? "처리 중이에요..." : "결제하기"}
      </button>
    </div>
  );
}
