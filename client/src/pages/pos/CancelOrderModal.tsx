import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api.js";
import type { KdsOrder } from "./OrderCard.js";

export type CancelReasonCode = "OUT_OF_STOCK" | "CUSTOMER_REQUEST" | "CANNOT_COOK" | "WRONG_ORDER" | "OTHER";

interface SoldOutTarget {
  kind: "MENU_ITEM" | "OPTION_CHOICE";
  id: string;
}

interface Impact {
  kind: "MENU_ITEM" | "OPTION_CHOICE";
  id: string;
  name: string;
  inventoryItem: { id: string; name: string } | null;
  alreadySoldOut: boolean;
  affectedMenuItems: { id: string; name: string }[];
  affectedOptionChoices: { id: string; name: string; groupName: string; menuItemName: string }[];
}

const targetKey = (t: SoldOutTarget) => `${t.kind}:${t.id}`;

/**
 * 주방 주문 취소(요구사항 2절).
 *
 * 1단계: 취소 사유 선택. '재료 소진'이면 바로 취소하지 않고 2단계로 넘어간다.
 * 2단계: 주문에 들어 있는 메뉴/옵션 중 실제로 떨어진 것을 고르고, 그것이 어디까지 영향을 주는지
 *        확인한 뒤 확정한다. **확정 전에는 아무 상태도 바뀌지 않는다** — 영향 조회는 읽기 전용이다.
 *
 * 확정하면 서버가 한 트랜잭션으로 취소 + 품절 + 감사 로그를 처리한다.
 */
export default function CancelOrderModal({
  order,
  onCancel,
  onDone,
}: {
  order: KdsOrder;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"reason" | "soldOut">("reason");
  const [reasonCode, setReasonCode] = useState<CancelReasonCode>("OUT_OF_STOCK");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<SoldOutTarget[]>([]);
  const [impact, setImpact] = useState<Impact[]>([]);
  const [impactLoading, setImpactLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const reasons: { code: CancelReasonCode; label: string }[] = [
    { code: "OUT_OF_STOCK", label: "재료 소진" },
    { code: "CUSTOMER_REQUEST", label: "고객 요청" },
    { code: "CANNOT_COOK", label: "조리 불가" },
    { code: "WRONG_ORDER", label: "잘못된 주문" },
    { code: "OTHER", label: "기타" },
  ];

  /** 이 주문에 들어 있는 메뉴와 옵션 — 품절 후보는 실제 주문 내용으로만 제한한다. */
  const candidates = useMemo(() => {
    const menus = new Map<string, string>();
    const options = new Map<string, { name: string; menuName: string }>();
    for (const item of order.items) {
      menus.set(item.menuItemId, item.nameSnapshot);
      for (const option of item.options) {
        if (option.optionChoiceId) options.set(option.optionChoiceId, { name: option.nameSnapshot, menuName: item.nameSnapshot });
      }
    }
    return { menus: [...menus.entries()], options: [...options.entries()] };
  }, [order]);

  // Esc로 닫기 + 첫 요소로 포커스 이동(키보드 조작).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  // 선택이 바뀔 때마다 영향 범위를 다시 읽는다(읽기 전용).
  useEffect(() => {
    if (step !== "soldOut" || selected.length === 0) {
      setImpact([]);
      return;
    }
    let cancelled = false;
    setImpactLoading(true);
    api
      .post("/api/staff/pos/sold-out-impact", { targets: selected })
      .then((d) => {
        if (!cancelled) setImpact(d.impact);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, "영향 범위를 확인하지 못했어요."));
      })
      .finally(() => {
        if (!cancelled) setImpactLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, selected]);

  function toggle(target: SoldOutTarget) {
    setSelected((prev) =>
      prev.some((t) => targetKey(t) === targetKey(target))
        ? prev.filter((t) => targetKey(t) !== targetKey(target))
        : [...prev, target],
    );
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/staff/pos/orders/${order.id}/cancel`, {
        reasonCode,
        note: note.trim() || undefined,
        soldOutTargets: reasonCode === "OUT_OF_STOCK" ? selected : undefined,
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err, "주문을 취소하지 못했어요."));
    } finally {
      setSubmitting(false);
    }
  }

  const totalAffected = impact.reduce(
    (sum, i) => sum + i.affectedMenuItems.length + i.affectedOptionChoices.length,
    0,
  );

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="주문 취소">
      <div className="modal-sheet modal-sheet--scroll" ref={dialogRef} tabIndex={-1}>
        {step === "reason" && (
          <>
            <h2>주문을 취소할까요?</h2>
            <p className="text-muted" style={{ fontSize: "0.9rem" }}>
              취소해도 테이블은 닫히지 않습니다. 자리 정리는 카운터에서 따로 해 주세요.
            </p>
            {reasons.map((r) => (
              <label key={r.code} className="reason-option">
                <input type="radio" name="cancel-reason" checked={reasonCode === r.code} onChange={() => setReasonCode(r.code)} />
                {r.label}
                {r.code === "OUT_OF_STOCK" && <span className="badge badge--warn">품절 처리 함께</span>}
              </label>
            ))}
            <input
              className="field"
              placeholder="메모 (선택, 기록에 남습니다)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
            />
            {error && <p className="error-text">{error}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={onCancel} disabled={submitting}>
                닫기
              </button>
              {reasonCode === "OUT_OF_STOCK" ? (
                <button className="btn-primary" style={{ flex: 1 }} onClick={() => setStep("soldOut")}>
                  다음: 품절 선택
                </button>
              ) : (
                <button className="btn-primary" style={{ flex: 1 }} onClick={submit} disabled={submitting}>
                  {submitting ? "처리 중…" : "취소하기"}
                </button>
              )}
            </div>
          </>
        )}

        {step === "soldOut" && (
          <>
            <h2>무엇이 떨어졌나요?</h2>
            <p className="text-muted" style={{ fontSize: "0.9rem" }}>
              실제로 품절된 메뉴나 옵션을 <strong>하나 이상</strong> 골라 주세요. 확인을 누르기 전에는 아무것도 바뀌지 않습니다.
            </p>

            <div className="soldout-group">
              <div className="soldout-group__title">메뉴</div>
              {candidates.menus.map(([id, name]) => (
                <label key={id} className="option-choice">
                  <input
                    type="checkbox"
                    checked={selected.some((t) => t.kind === "MENU_ITEM" && t.id === id)}
                    onChange={() => toggle({ kind: "MENU_ITEM", id })}
                  />
                  <span className="option-choice__name">{name}</span>
                </label>
              ))}
            </div>

            {candidates.options.length > 0 && (
              <div className="soldout-group">
                <div className="soldout-group__title">옵션</div>
                {candidates.options.map(([id, info]) => (
                  <label key={id} className="option-choice">
                    <input
                      type="checkbox"
                      checked={selected.some((t) => t.kind === "OPTION_CHOICE" && t.id === id)}
                      onChange={() => toggle({ kind: "OPTION_CHOICE", id })}
                    />
                    <span className="option-choice__name">
                      {info.name} <span className="text-muted">({info.menuName})</span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            {/* 영향 범위 — 공용 물품을 공유하면 다른 메뉴/옵션까지 함께 막힌다. */}
            {impactLoading && <p className="text-muted">영향 범위를 확인하는 중이에요…</p>}
            {!impactLoading && impact.length > 0 && (
              <div className="soldout-impact">
                <div className="soldout-impact__head">
                  이 선택으로 <strong>{totalAffected}곳</strong>이 함께 품절됩니다.
                </div>
                {impact.map((i) => (
                  <div key={`${i.kind}:${i.id}`} className="soldout-impact__row">
                    <strong>{i.name}</strong>
                    {i.inventoryItem ? (
                      <span className="text-muted"> · 공용 물품 «{i.inventoryItem.name}» 공유</span>
                    ) : (
                      <span className="text-muted"> · 이 항목에만 적용</span>
                    )}
                    {i.alreadySoldOut && <span className="badge badge--warn">이미 품절</span>}
                    {(i.affectedMenuItems.length > 0 || i.affectedOptionChoices.length > 0) && (
                      <ul className="soldout-impact__list">
                        {i.affectedMenuItems.map((m) => (
                          <li key={m.id}>메뉴 · {m.name}</li>
                        ))}
                        {i.affectedOptionChoices.map((c) => (
                          <li key={c.id}>
                            옵션 · {c.menuItemName} &gt; {c.groupName} &gt; {c.name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            {error && <p className="error-text">{error}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setStep("reason")} disabled={submitting}>
                이전
              </button>
              <button className="btn-danger" style={{ flex: 1 }} onClick={submit} disabled={submitting || selected.length === 0}>
                {submitting ? "처리 중…" : "취소하고 품절 처리"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
