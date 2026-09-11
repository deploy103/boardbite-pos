import { useState } from "react";
import { formatWon } from "./format.js";

const DISCOUNT_REASONS = ["단체 할인", "직원 재량", "행사 이벤트", "기타"];

/** 할인 적용 모달(요구사항.md §12.1, §12.4) — 남은 금액 이하로만 입력 가능하게 클라이언트에서도 미리 막는다. */
export default function DiscountModal({
  remainingAmount,
  onCancel,
  onConfirm,
  submitting,
}: {
  remainingAmount: number;
  onCancel: () => void;
  onConfirm: (amount: number, reason: string) => void;
  submitting: boolean;
}) {
  const [amountText, setAmountText] = useState("");
  const [selectedReason, setSelectedReason] = useState(DISCOUNT_REASONS[0]);
  const [customText, setCustomText] = useState("");

  const amount = Number(amountText) || 0;
  const finalReason = selectedReason === "기타" ? customText.trim() : selectedReason;
  const canConfirm = amount > 0 && amount <= remainingAmount && finalReason.length > 0 && !submitting;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-sheet">
        <h2>할인 적용</h2>
        <p className="text-muted">남은 금액 {formatWon(remainingAmount)} 이하로 할인할 수 있어요.</p>
        <input
          className="field"
          type="number"
          min={1}
          max={remainingAmount}
          inputMode="numeric"
          placeholder="할인 금액"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
        />
        {amount > remainingAmount && <p className="error-text">남은 금액보다 큰 금액은 할인할 수 없어요.</p>}
        {DISCOUNT_REASONS.map((reason) => (
          <label key={reason} className="reason-option">
            <input
              type="radio"
              name="discount-reason"
              checked={selectedReason === reason}
              onChange={() => setSelectedReason(reason)}
            />
            {reason}
          </label>
        ))}
        {selectedReason === "기타" && (
          <input
            className="field"
            placeholder="사유를 입력해 주세요"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
          />
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn-secondary" style={{ flex: 1 }} onClick={onCancel} disabled={submitting}>
            닫기
          </button>
          <button
            className="btn-primary"
            style={{ flex: 1 }}
            disabled={!canConfirm}
            onClick={() => onConfirm(amount, finalReason)}
          >
            {submitting ? "처리 중..." : "할인 적용"}
          </button>
        </div>
      </div>
    </div>
  );
}
