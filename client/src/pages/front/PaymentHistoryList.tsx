import { formatWon } from "./format.js";
import type { PaymentRow } from "./types.js";

const KIND_LABEL: Record<string, string> = {
  CHARGE: "결제",
  DISCOUNT: "할인",
  VOID: "취소",
  REFUND: "환불",
};

const METHOD_LABEL: Record<string, string> = {
  CASH: "현금",
  CARD: "카드",
  OTHER: "기타",
  DISCOUNT: "할인",
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 결제 내역(요구사항.md §12.3, §12.8). 이미 취소/환불된 결제이거나 그 자체가 취소/환불 기록이면
 * "취소" 버튼을 숨긴다 — `reversedPaymentId`가 이 payment.id를 가리키는 다른 레코드가 있는지로 판단한다.
 */
export default function PaymentHistoryList({
  payments,
  onVoid,
}: {
  payments: PaymentRow[];
  onVoid: (payment: PaymentRow) => void;
}) {
  if (payments.length === 0) {
    return <p className="text-muted">아직 결제 내역이 없어요.</p>;
  }

  const reversedIds = new Set(payments.filter((p) => p.reversedPaymentId).map((p) => p.reversedPaymentId as string));
  const ordered = [...payments].reverse();

  return (
    <ul className="checkout-history-list">
      {ordered.map((p) => {
        const isReversal = p.kind === "VOID" || p.kind === "REFUND";
        const canVoid = (p.kind === "CHARGE" || p.kind === "DISCOUNT") && !reversedIds.has(p.id);
        return (
          <li key={p.id} className={`checkout-history-row${isReversal ? " checkout-history-row--reversal" : ""}`}>
            <div className="checkout-history-row__main">
              <span className="badge">{KIND_LABEL[p.kind] ?? p.kind}</span>
              <span className="checkout-history-row__method">{METHOD_LABEL[p.method] ?? p.method}</span>
              <strong className="checkout-history-row__amount">{formatWon(p.amount)}</strong>
            </div>
            <div className="text-muted checkout-history-row__meta">
              {formatTime(p.createdAt)} · {p.createdBy.displayName}
              {p.payerLabel && ` · ${p.payerLabel}`}
            </div>
            {p.tenderedAmount != null && (
              <div className="text-muted checkout-history-row__meta">
                받은 금액 {formatWon(p.tenderedAmount)} · 거스름돈 {formatWon(p.changeAmount ?? 0)}
              </div>
            )}
            {p.reason && <div className="text-muted checkout-history-row__meta">사유: {p.reason}</div>}
            {canVoid && (
              <button className="btn-secondary checkout-history-row__void" onClick={() => onVoid(p)}>
                취소
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
