import { useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import PaymentMethodPicker from "./PaymentMethodPicker.js";
import CashQuickAmount from "./CashQuickAmount.js";
import { formatWon } from "./format.js";
import type { PaymentMethod, Settlement } from "./types.js";

interface SplitSuggestion {
  totalAmount: number;
  people: number;
  shares: number[];
}

/** "더치페이" 탭 — N명 균등분할(요구사항.md §12.5). 나머지 원은 서버(splitEvenly)가 정확히 배분해 준다. */
export default function DutchSplitPanel({
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
  const [peopleText, setPeopleText] = useState("2");
  const [suggestion, setSuggestion] = useState<SplitSuggestion | null>(null);
  const [paidRows, setPaidRows] = useState<Set<number>>(new Set());
  const [loadingSuggestion, setLoadingSuggestion] = useState(false);
  const [activeRow, setActiveRow] = useState<number | null>(null);

  async function fetchSuggestion() {
    const people = Number(peopleText);
    if (!Number.isInteger(people) || people < 1) {
      onError("인원수를 올바르게 입력해 주세요.");
      return;
    }
    setLoadingSuggestion(true);
    try {
      const data: SplitSuggestion = await api.get(
        `/api/staff/front/table-sessions/${tableSessionId}/split-suggestion?people=${people}`,
      );
      setSuggestion(data);
      setPaidRows(new Set());
      setActiveRow(null);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "더치페이 계산 중 오류가 발생했어요.");
    } finally {
      setLoadingSuggestion(false);
    }
  }

  function handlePaid(index: number, settlement: Settlement) {
    setPaidRows((prev) => new Set(prev).add(index));
    setActiveRow(null);
    onSubmitted(settlement);
  }

  if (owed <= 0) {
    return <p className="text-muted">남은 금액이 없어요. 더치페이를 진행할 필요가 없어요.</p>;
  }

  return (
    <div className="checkout-panel">
      <div className="checkout-dutch-input-row">
        <input
          className="field checkout-dutch-input"
          type="number"
          min={1}
          inputMode="numeric"
          value={peopleText}
          onChange={(e) => setPeopleText(e.target.value)}
          placeholder="인원수"
        />
        <button className="btn-secondary" onClick={fetchSuggestion} disabled={loadingSuggestion}>
          {loadingSuggestion ? "계산 중..." : "인원수로 나누기"}
        </button>
      </div>
      {suggestion && (
        <ul className="checkout-dutch-list">
          {suggestion.shares.map((share, idx) => {
            const isPaid = paidRows.has(idx);
            return (
              <li key={idx} className={`checkout-dutch-row${isPaid ? " checkout-dutch-row--paid" : ""}`}>
                <div className="checkout-dutch-row__label">
                  <strong>{idx + 1}번 손님</strong>
                  <span>{formatWon(share)}</span>
                </div>
                {isPaid ? (
                  <span className="badge">결제 완료</span>
                ) : activeRow === idx ? (
                  <DutchPayForm
                    tableSessionId={tableSessionId}
                    methods={methods}
                    payerLabel={`${idx + 1}번 손님`}
                    suggestedAmount={share}
                    remainingAmount={owed}
                    onCancel={() => setActiveRow(null)}
                    onSubmitted={(settlement) => handlePaid(idx, settlement)}
                    onError={onError}
                  />
                ) : (
                  <button className="btn-secondary" onClick={() => setActiveRow(idx)}>
                    이 금액으로 결제
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DutchPayForm({
  tableSessionId,
  methods,
  payerLabel,
  suggestedAmount,
  remainingAmount,
  onCancel,
  onSubmitted,
  onError,
}: {
  tableSessionId: string;
  methods: PaymentMethod[];
  payerLabel: string;
  suggestedAmount: number;
  /** 세션 전체 남은 금액 — 현금 결제 시 실제 적용액의 상한(서버 규칙과 동일) */
  remainingAmount: number;
  onCancel: () => void;
  onSubmitted: (settlement: Settlement) => void;
  onError: (message: string) => void;
}) {
  const [methodCode, setMethodCode] = useState<string | null>(methods[0]?.code ?? null);
  const [amountText, setAmountText] = useState(String(suggestedAmount));
  const [tendered, setTendered] = useState(suggestedAmount);
  const [submitting, setSubmitting] = useState(false);

  const selectedMethod = methods.find((m) => m.code === methodCode) ?? null;
  const amount = Number(amountText) || 0;
  const canSubmit =
    !submitting &&
    selectedMethod !== null &&
    (selectedMethod.isCash ? tendered > 0 : amount > 0 && amount <= remainingAmount);

  async function submit() {
    if (!selectedMethod) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        idempotencyKey: crypto.randomUUID(),
        methodCode: selectedMethod.code,
        mode: "AMOUNT",
        payerLabel,
      };
      if (selectedMethod.isCash) {
        body.tenderedAmount = tendered;
      } else {
        body.amount = amount;
      }
      const result = await api.post(`/api/staff/front/table-sessions/${tableSessionId}/payments`, body);
      onSubmitted(result.settlement);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "결제 처리 중 오류가 발생했어요.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="checkout-dutch-form">
      <PaymentMethodPicker methods={methods} selectedCode={methodCode} onSelect={setMethodCode} />
      {selectedMethod?.isCash ? (
        <CashQuickAmount
          targetAmount={suggestedAmount}
          capAmount={remainingAmount}
          tendered={tendered}
          onChange={setTendered}
        />
      ) : (
        <input
          className="field"
          type="number"
          min={1}
          max={remainingAmount}
          inputMode="numeric"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
        />
      )}
      <div className="checkout-dutch-form__actions">
        <button className="btn-secondary" onClick={onCancel} disabled={submitting}>
          닫기
        </button>
        <button className="btn-primary" disabled={!canSubmit} onClick={submit}>
          {submitting ? "처리 중..." : "결제 확정"}
        </button>
      </div>
    </div>
  );
}
