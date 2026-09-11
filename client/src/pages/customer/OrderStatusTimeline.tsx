import { ORDER_STATUS_STEPS } from "./types.js";

// 색상만으로 상태를 구분하지 않는다 — 단계 텍스트를 항상 함께 보여준다 (요구사항 9.1, docs/RESEARCH.md).
export default function OrderStatusTimeline({
  status,
  rejectReason,
  cancelReason,
}: {
  status: string;
  rejectReason?: string | null;
  cancelReason?: string | null;
}) {
  if (status === "REJECTED" || status === "CANCELLED") {
    const reason = status === "REJECTED" ? rejectReason : cancelReason;
    return (
      <div className="status-alert">
        {status === "REJECTED" ? "주문이 거부됐어요" : "주문이 취소됐어요"}
        {reason && <span className="status-alert__reason">사유: {reason}</span>}
      </div>
    );
  }

  const currentIndex = ORDER_STATUS_STEPS.findIndex((step) => step.key === status);

  return (
    <div className="status-timeline" role="list" aria-label="주문 처리 단계">
      {ORDER_STATUS_STEPS.map((step, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "pending";
        return (
          <div className={`status-step status-step--${state}`} key={step.key} role="listitem">
            <span className="status-step__dot" aria-hidden="true" />
            <span className="status-step__label">{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}
