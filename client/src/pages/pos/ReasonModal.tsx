import { useState } from "react";
import { ORDER_REASONS } from "./reasons.js";

export default function ReasonModal({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [selected, setSelected] = useState(ORDER_REASONS[0]);
  const [customText, setCustomText] = useState("");

  const finalReason = selected === "기타" ? customText.trim() : selected;
  const canConfirm = finalReason.length > 0;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-sheet">
        <h2>{title}</h2>
        {ORDER_REASONS.map((reason) => (
          <label key={reason} className="reason-option">
            <input type="radio" name="reason" checked={selected === reason} onChange={() => setSelected(reason)} />
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
          <button className="btn-secondary" style={{ flex: 1 }} onClick={onCancel}>
            닫기
          </button>
          <button className="btn-primary" style={{ flex: 1 }} disabled={!canConfirm} onClick={() => onConfirm(finalReason)}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}
