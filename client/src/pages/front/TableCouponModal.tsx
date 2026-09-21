import { useState } from "react";
import { api, errorMessage } from "../../lib/api.js";
import { formatWon } from "./format.js";

export interface TableCouponPreview {
  code: string;
  type: "AMOUNT" | "ITEM";
  benefitLabel: string;
  discountAmount: number;
  targetOrderItemId: string | null;
  targetName: string | null;
  remainingBefore: number;
  remainingAfter: number;
  candidates: { orderItemId: string; name: string; unitPrice: number; quantity: number }[];
}

/**
 * 테이블 정산에서 쿠폰을 쓰는 창(요구사항.md §6.2).
 *
 * 번호 입력 → 혜택/할인액 확인 → (상품권이면 적용할 메뉴 선택) → 적용.
 * **확인 단계에서는 쿠폰이 소진되지 않는다.** 실제 소진은 '적용하기'를 눌러 서버가 한 트랜잭션으로
 * 할인 원장을 기록할 때만 일어난다. 금액은 전부 서버가 계산한 값을 그대로 보여준다.
 */
export default function TableCouponModal({
  tableSessionId,
  onApplied,
  onCancel,
}: {
  tableSessionId: string;
  onApplied: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<TableCouponPreview | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(nextTargetId: string | null = targetId) {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.post(`/api/staff/front/table-sessions/${tableSessionId}/coupon/preview`, {
        code: code.trim(),
        targetOrderItemId: nextTargetId,
      });
      setPreview(data.preview);
      setCode(data.preview.code);
      if (!nextTargetId && data.preview.targetOrderItemId) setTargetId(data.preview.targetOrderItemId);
    } catch (err) {
      setPreview(null);
      setError(errorMessage(err, "쿠폰을 확인하지 못했어요."));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/staff/front/table-sessions/${tableSessionId}/coupon`, {
        code: preview.code,
        targetOrderItemId: targetId,
        idempotencyKey: crypto.randomUUID(),
      });
      onApplied();
    } catch (err) {
      setError(errorMessage(err, "쿠폰을 적용하지 못했어요."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="쿠폰 사용">
        <div className="sheet-handle" />
        <div className="sheet-header">
          <h2 className="sheet-title">쿠폰 사용</h2>
          <button type="button" className="sheet-close" onClick={onCancel}>
            닫기
          </button>
        </div>
        <p className="sheet-desc">
          거래당 한 장만 쓸 수 있어요. 확인만으로는 사용되지 않고, <strong>적용하기</strong>를 눌러야 사용 완료 처리됩니다.
          할인 후에는 남은 금액이 줄어드니, 정산은 <strong>금액으로 결제</strong>를 쓰세요
          (상품별 결제는 정가 기준이라 줄어든 남은 금액을 넘을 수 없습니다).
        </p>

        <div className="counter-coupon-row">
          <input
            className="field"
            style={{ marginBottom: 0 }}
            placeholder="쿠폰 번호 (예: 1 / 01 / 001)"
            inputMode="numeric"
            maxLength={3}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/[^0-9]/g, ""));
              setPreview(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && check()}
            aria-label="쿠폰 번호"
            autoFocus
          />
          <button className="btn-secondary" onClick={() => check()} disabled={busy || !code.trim()}>
            {busy ? "확인 중" : "혜택 확인"}
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        {preview && (
          <>
            <div className="counter-coupon-applied" style={{ marginTop: 12 }}>
              <div>
                <strong>{preview.code}번</strong> · {preview.benefitLabel}
                <div className="text-muted">
                  {preview.type === "AMOUNT"
                    ? "남는 금액은 돌려드리지 않아요(잔액 소멸)."
                    : "대상 메뉴 1개의 기본 가격만 무료예요. 유료 옵션은 따로 결제합니다."}
                </div>
              </div>
            </div>

            {preview.type === "ITEM" && preview.candidates.length > 0 && (
              <div className="counter-coupon-targets">
                <div className="checkout-field-label">무료로 제공할 메뉴 1개</div>
                {preview.candidates.map((c) => (
                  <label className="option-choice" key={c.orderItemId}>
                    <input
                      type="radio"
                      name="table-coupon-target"
                      checked={(targetId ?? preview.candidates[0].orderItemId) === c.orderItemId}
                      onChange={() => {
                        setTargetId(c.orderItemId);
                        void check(c.orderItemId);
                      }}
                    />
                    <span className="option-choice__name">
                      {c.name} × {c.quantity}
                    </span>
                    <span className="option-choice__price">기본가 {formatWon(c.unitPrice)}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="bill-card">
              <div className="bill-card__row">
                <span>지금 남은 금액</span>
                <span>{formatWon(preview.remainingBefore)}</span>
              </div>
              <div className="bill-card__row">
                <span>쿠폰 할인</span>
                <span>-{formatWon(preview.discountAmount)}</span>
              </div>
              <div className="bill-card__row bill-card__row--total">
                <span>적용 후 남는 금액</span>
                <span>{formatWon(preview.remainingAfter)}</span>
              </div>
            </div>
          </>
        )}

        <div className="sheet-footer">
          <button className="btn-primary" onClick={apply} disabled={!preview || busy}>
            {busy ? "적용하는 중..." : "적용하기"}
          </button>
        </div>
      </div>
    </div>
  );
}
