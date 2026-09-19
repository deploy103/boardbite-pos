import { useState, type FormEvent } from "react";

interface Props {
  title: string;
  /** 이 작업이 무엇을 남기는지 구체적으로 — "정말 하시겠습니까?"만으로는 사고를 막지 못한다. */
  description: string;
  /** 사유 입력이 필수인 작업(강제 종료, 환불, 로그 삭제 등). */
  requireReason?: boolean;
  reasonPlaceholder?: string;
  confirmLabel: string;
  /** 추가로 보여줄 현황(남은 금액, 미서빙 주문 등). */
  details?: { label: string; value: string }[];
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/**
 * 위험 작업 전용 확인 대화상자(요구사항2.md §10.2).
 * 일반 확인과 시각적으로 확실히 구분되고, 필요하면 사유를 반드시 받는다.
 */
export default function DangerConfirmModal({
  title,
  description,
  requireReason,
  reasonPlaceholder,
  confirmLabel,
  details,
  onConfirm,
  onCancel,
}: Props) {
  const [reason, setReason] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    onConfirm(reason.trim());
  }

  return (
    <div className="sheet-overlay" onClick={onCancel}>
      <div className="sheet danger-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <h2 className="sheet-title danger-title">{title}</h2>
          <button type="button" className="sheet-close" onClick={onCancel}>
            닫기
          </button>
        </div>
        <p className="sheet-desc">{description}</p>
        {details && details.length > 0 && (
          <ul className="danger-details">
            {details.map((d) => (
              <li key={d.label}>
                <span className="text-muted">{d.label}</span>
                <strong>{d.value}</strong>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={onSubmit}>
          {requireReason && (
            <input
              className="field"
              placeholder={reasonPlaceholder ?? "사유를 입력해 주세요 (기록에 남습니다)"}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              autoFocus
            />
          )}
          <button className="btn-danger" type="submit" disabled={requireReason && reason.trim().length === 0}>
            {confirmLabel}
          </button>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            취소
          </button>
        </form>
      </div>
    </div>
  );
}
