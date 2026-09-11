import { useState } from "react";

// client/src/pages/pos/ReasonModal.tsx의 사유 선택 패턴을 참고해 결제 취소용으로 새로 작성했다(요구사항.md §12.8).
const VOID_REASONS = ["입력 실수", "고객 요청", "중복 결제", "기타"];

export default function VoidReasonModal({
  amountLabel,
  onCancel,
  onConfirm,
  submitting,
}: {
  amountLabel: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  submitting: boolean;
}) {
  const [selected, setSelected] = useState(VOID_REASONS[0]);
  const [customText, setCustomText] = useState("");

  const finalReason = selected === "기타" ? customText.trim() : selected;
  const canConfirm = finalReason.length > 0 && !submitting;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-sheet">
        <h2>결제 취소</h2>
        <p className="text-muted">{amountLabel} 결제를 취소할까요? 취소 사유를 선택해 주세요.</p>
        {VOID_REASONS.map((reason) => (
          <label key={reason} className="reason-option">
            <input type="radio" name="void-reason" checked={selected === reason} onChange={() => setSelected(reason)} />
            {reason}
          </label>
        ))}
        {selected === "기타" && (
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
          <button className="btn-primary" style={{ flex: 1 }} disabled={!canConfirm} onClick={() => onConfirm(finalReason)}>
            {submitting ? "처리 중..." : "취소 확정"}
          </button>
        </div>
      </div>
    </div>
  );
}
