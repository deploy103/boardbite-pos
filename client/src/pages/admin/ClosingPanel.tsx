import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner, useStepUpGuard } from "./shared.js";
import StepUpModal from "../../components/StepUpModal.js";

interface ClosingPreview {
  openedAt: string;
  closedAt: string;
  totalOrderAmount: number;
  totalRevenue: number;
  totalDiscount: number;
  totalVoid: number;
  totalRefund: number;
  byMethod: { method: string; amount: number }[];
  expectedCash: number;
  cancelledOrderCount: number;
  rejectedOrderCount: number;
  unsettledTables: { tableId: string; tableNumber: number; status: string; remainingAmount: number }[];
  forceClosedSessions: { tableSessionId: string; tableNumber: number; closedAt: string | null; reason: string | null }[];
}

interface Settlement {
  id: string;
  openedAt: string;
  closedAt: string;
  expectedCash: number;
  actualCash: number;
  cashDifference: number;
  totalRevenue: number;
  note: string | null;
  closedBy?: { displayName: string };
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const time = (iso: string) => new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

function Cell({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="closing-cell">
      <div className="closing-cell__label">{label}</div>
      <div className={`closing-cell__value ${negative ? "closing-cell__value--negative" : ""}`}>{value}</div>
    </div>
  );
}

/**
 * 영업 마감/정산(요구사항2.md §9.1).
 *
 * 마감은 금전 원장을 확정하는 작업이라 서버가 step-up 재인증을 요구하고, 미정산 테이블이
 * 남아 있으면 사유 없이는 진행되지 않는다. 확정된 결과는 수정하지 않는 스냅샷으로 저장된다.
 */
export default function ClosingPanel({ mfaEnabled }: { mfaEnabled: boolean }) {
  const [preview, setPreview] = useState<ClosingPreview | null>(null);
  const [history, setHistory] = useState<Settlement[]>([]);
  const [actualCash, setActualCash] = useState("");
  const [note, setNote] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [done, setDone] = useState<Settlement | null>(null);
  const { error, setError, wrap } = useErrorBanner();
  const { pending, setPending, guard } = useStepUpGuard();

  const refresh = useCallback(async () => {
    const [p, h] = await Promise.all([
      api.get("/api/staff/admin/closing/preview"),
      api.get("/api/staff/admin/closing/history"),
    ]);
    setPreview(p.preview);
    setHistory(h.settlements);
  }, []);

  useEffect(() => {
    refresh().catch(() => setError("마감 정보를 불러오지 못했어요."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasUnsettled = (preview?.unsettledTables.length ?? 0) > 0;
  const cashDifference = preview && actualCash !== "" ? Number(actualCash) - preview.expectedCash : null;

  const submit = wrap(async () => {
    if (actualCash === "") {
      setError("실제 현금 금액을 입력해 주세요.");
      return;
    }
    await guard("영업 마감", async () => {
      const result = await api.post("/api/staff/admin/closing", {
        actualCash: Number(actualCash),
        note: note || undefined,
        overrideReason: overrideReason || undefined,
      });
      setDone(result.settlement);
      setActualCash("");
      setNote("");
      setOverrideReason("");
      await refresh();
    });
  });

  if (!preview) {
    return (
      <section>
        {error ? <p className="error-text">{error}</p> : <p className="text-muted">마감 정보를 불러오는 중이에요...</p>}
      </section>
    );
  }

  return (
    <section>
      <h2>영업 마감</h2>
      <p className="text-muted">
        집계 구간: {time(preview.openedAt)} ~ {time(preview.closedAt)} (직전 마감 이후)
      </p>

      <div className="closing-grid">
        <Cell label="총 주문 금액" value={won(preview.totalOrderAmount)} />
        <Cell label="실제 매출" value={won(preview.totalRevenue)} />
        <Cell label="총 할인" value={won(preview.totalDiscount)} />
        <Cell label="결제 취소(VOID)" value={won(preview.totalVoid)} negative={preview.totalVoid > 0} />
        <Cell label="환불(REFUND)" value={won(preview.totalRefund)} negative={preview.totalRefund > 0} />
        <Cell label="취소 주문" value={`${preview.cancelledOrderCount}건`} />
        <Cell label="거부 주문" value={`${preview.rejectedOrderCount}건`} />
        <Cell label="현금 예상액" value={won(preview.expectedCash)} />
      </div>

      <h3 style={{ marginTop: 24 }}>결제수단별 매출</h3>
      {preview.byMethod.length === 0 && <p className="text-muted">집계 구간에 결제가 없어요.</p>}
      {preview.byMethod.map((m) => (
        <div key={m.method} className="list-row">
          <span>{m.method}</span>
          <strong>{won(m.amount)}</strong>
        </div>
      ))}

      <h3 style={{ marginTop: 24 }}>정리되지 않은 테이블</h3>
      {!hasUnsettled && <p className="text-muted">모든 테이블이 정리됐어요.</p>}
      {preview.unsettledTables.map((t) => (
        <div key={t.tableId} className="list-row">
          <span>
            {t.tableNumber}번 · <span className="badge badge--warn">{t.status}</span>
          </span>
          <strong className={t.remainingAmount > 0 ? "closing-cell__value--negative" : ""}>
            미수 {won(t.remainingAmount)}
          </strong>
        </div>
      ))}

      <h3 style={{ marginTop: 24 }}>강제 종료된 테이블</h3>
      {preview.forceClosedSessions.length === 0 && <p className="text-muted">강제 종료 내역이 없어요.</p>}
      {preview.forceClosedSessions.map((s) => (
        <div key={s.tableSessionId} className="list-row">
          <span>
            {s.tableNumber}번 · {s.closedAt ? time(s.closedAt) : "-"}
          </span>
          <span className="text-muted">{s.reason}</span>
        </div>
      ))}

      <h3 style={{ marginTop: 24 }}>마감 확정</h3>
      <input
        className="field"
        type="number"
        inputMode="numeric"
        placeholder="실제 금고 현금(원)"
        value={actualCash}
        onChange={(e) => setActualCash(e.target.value)}
      />
      {cashDifference !== null && (
        <p className={cashDifference === 0 ? "text-muted" : "error-text"}>
          현금 차액: {cashDifference > 0 ? "+" : ""}
          {won(cashDifference)}
          {cashDifference === 0 && " (일치)"}
        </p>
      )}
      <input className="field" placeholder="메모(선택)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />

      {hasUnsettled && (
        <>
          <p className="error-text">
            아직 사용 중인 테이블이 {preview.unsettledTables.length}곳 있어요. 그래도 마감하려면 사유를 남겨야 합니다.
          </p>
          <input
            className="field"
            placeholder="미정산 상태로 마감하는 사유 (기록에 남습니다)"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            maxLength={200}
          />
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      <button
        className={hasUnsettled ? "btn-danger" : "btn-primary"}
        onClick={submit}
        disabled={actualCash === "" || (hasUnsettled && overrideReason.trim().length === 0)}
      >
        {hasUnsettled ? "경고를 확인하고 마감" : "영업 마감하기"}
      </button>
      <a className="btn-secondary" style={{ display: "block", textAlign: "center", textDecoration: "none", marginTop: 8 }}
         href="/api/staff/admin/export/closing.csv">
        마감 내역 CSV 내려받기
      </a>

      {done && (
        <p className="text-muted" style={{ marginTop: 16 }}>
          마감 완료 — 현금 차액 {won(done.cashDifference)}. 이 기록은 수정되지 않습니다.
        </p>
      )}

      <h3 style={{ marginTop: 32 }}>지난 마감</h3>
      {history.length === 0 && <p className="text-muted">아직 마감 기록이 없어요.</p>}
      {history.map((s) => (
        <div key={s.id} className="list-row">
          <div>
            <strong>{time(s.closedAt)}</strong>
            <div className="text-muted">
              매출 {won(s.totalRevenue)} · 현금 차액 {won(s.cashDifference)}
              {s.closedBy && ` · ${s.closedBy.displayName}`}
            </div>
          </div>
        </div>
      ))}

      {pending && (
        <StepUpModal
          purpose={pending.purpose}
          mfaEnabled={mfaEnabled}
          onSuccess={() => {
            const retry = pending.retry;
            setPending(null);
            void retry().catch(() => setError("마감 처리 중 오류가 발생했어요."));
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
