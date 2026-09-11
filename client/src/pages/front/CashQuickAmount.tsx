import { formatWon } from "./format.js";

/**
 * 현금 결제 "받은 금액" 입력 UI (요구사항.md §12.2).
 *
 * 서버(server/src/services/payment.ts)의 계산 규칙과 정확히 맞춰 미리보기를 계산한다:
 * - AMOUNT 모드: 실제 적용 금액 = min(받은금액, 그 시점 세션 전체 남은금액). `capAmount`에 그 남은금액을 넘긴다.
 * - ITEMS 모드: 실제 적용 금액은 선택한 상품 합계로 고정된다(받은금액이 그 이상이어야 함). `capAmount`를 넘기지 않는다.
 */
export default function CashQuickAmount({
  targetAmount,
  capAmount,
  tendered,
  onChange,
}: {
  /** "정확히" 버튼이 채워줄 금액(남은 금액 또는 더치페이 제안 금액 또는 선택한 상품 합계) */
  targetAmount: number;
  /** AMOUNT 모드에서만 넘긴다 — 실제 적용액이 이 값을 넘지 못한다(세션 전체 남은 금액) */
  capAmount?: number;
  tendered: number;
  onChange: (value: number) => void;
}) {
  const applied = capAmount !== undefined ? Math.min(tendered, Math.max(capAmount, 0)) : targetAmount;
  const change = Math.max(tendered - applied, 0);
  const insufficient = capAmount === undefined && tendered > 0 && tendered < targetAmount;

  const quickAdd = (delta: number) => onChange(Math.max(0, tendered + delta));

  return (
    <div className="checkout-cash-panel">
      <div className="checkout-quick-row">
        <button type="button" className="btn-secondary" onClick={() => onChange(targetAmount)}>
          정확히
        </button>
        <button type="button" className="btn-secondary" onClick={() => quickAdd(1000)}>
          +1,000
        </button>
        <button type="button" className="btn-secondary" onClick={() => quickAdd(5000)}>
          +5,000
        </button>
        <button type="button" className="btn-secondary" onClick={() => quickAdd(10000)}>
          +10,000
        </button>
      </div>
      <label className="checkout-field-label" htmlFor="checkout-tendered-amount">
        받은 금액 직접 입력
      </label>
      <input
        id="checkout-tendered-amount"
        className="field"
        type="number"
        min={0}
        inputMode="numeric"
        value={tendered || ""}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        placeholder="받은 금액"
      />
      {insufficient && <p className="error-text">받은 금액이 상품 금액보다 적어요.</p>}
      <div className="checkout-cash-summary">
        <div className="checkout-cash-summary__row">
          <span>받은 금액</span>
          <strong>{formatWon(tendered)}</strong>
        </div>
        <div className="checkout-cash-summary__row checkout-cash-summary__row--change">
          <span>거스름돈</span>
          <strong>{formatWon(change)}</strong>
        </div>
      </div>
    </div>
  );
}
