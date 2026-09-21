import { useCallback, useEffect, useState } from "react";
import { api, ApiError, errorMessage } from "../../lib/api.js";
import { useStaffSocket } from "../../lib/useStaffSocket.js";
import StepUpModal from "../../components/StepUpModal.js";
import DangerConfirmModal from "../../components/DangerConfirmModal.js";
import { CounterSaleBody } from "./CounterSaleReceipt.js";
import { formatWon } from "./format.js";
import type { CounterSaleDetail } from "./counterTypes.js";

const time = (iso: string) => new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

/**
 * 현장 거래 이력(요구사항.md §5.2).
 *
 * 소켓은 "다시 불러올 시점"을 알리는 신호로만 쓰고, 화면은 항상 REST 목록을 다시 조회한다.
 * 이벤트를 놓쳐도 15초 주기 재조회로 복구된다(요구사항.md §12.4).
 */
export default function CounterSalesList({ role, mfaEnabled }: { role: string; mfaEnabled: boolean }) {
  const [sales, setSales] = useState<CounterSaleDetail[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [searchNo, setSearchNo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CounterSaleDetail | null>(null);
  const [pendingCancel, setPendingCancel] = useState<{ id: string; reason: string } | null>(null);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (onlyOpen) params.set("onlyOpen", "true");
    if (searchNo.trim()) params.set("saleNo", searchNo.trim());
    const data = await api.get(`/api/staff/front/counter/sales?${params.toString()}`);
    setSales(data.sales);
  }, [onlyOpen, searchNo]);

  useEffect(() => {
    refresh().catch((err) => setError(errorMessage(err, "현장 거래 목록을 불러오지 못했어요.")));
    const interval = setInterval(() => refresh().catch(() => undefined), 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  useStaffSocket((event) => {
    if (event === "counter-sale:recorded" || event === "order:status-changed") {
      refresh().catch(() => undefined);
    }
  });

  async function markPickedUp(orderId: string) {
    try {
      setError(null);
      await api.post(`/api/staff/front/counter/orders/${orderId}/picked-up`, {});
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "수령 완료 처리에 실패했어요."));
    }
  }

  /** 거래 전체 취소/환불 — ADMIN 권한 + step-up + 사유가 필요하다. */
  async function submitCancel(id: string, reason: string) {
    try {
      setError(null);
      await api.post(`/api/staff/admin/counter-sales/${id}/cancel`, { reason });
      setCancelTarget(null);
      setPendingCancel(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "STEP_UP_REQUIRED") {
        setPendingCancel({ id, reason });
        setCancelTarget(null);
        return;
      }
      setError(errorMessage(err, "거래를 취소하지 못했어요."));
    }
  }

  return (
    <section>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input
          className="field"
          style={{ marginBottom: 0, width: 160 }}
          placeholder="주문번호 검색"
          inputMode="numeric"
          value={searchNo}
          onChange={(e) => setSearchNo(e.target.value.replace(/[^0-9]/g, ""))}
          aria-label="주문번호 검색"
        />
        <button className="btn-secondary" onClick={() => setOnlyOpen((v) => !v)} aria-pressed={onlyOpen}>
          {onlyOpen ? "전체 보기" : "미수령·환불 필요만"}
        </button>
        <button className="btn-secondary" onClick={() => refresh().catch(() => undefined)}>
          새로고침
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {sales.length === 0 && <p className="text-muted">표시할 현장 거래가 없어요.</p>}

      {sales.map((sale) => {
        const open = expanded === sale.id;
        const readyOrders = sale.orders.filter((o) => o.status === "READY");
        return (
          <div key={sale.id} className={`list-row ${sale.status === "CANCELLED" ? "list-row--disabled" : ""}`} style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong>#{String(sale.saleNo).padStart(3, "0")}</strong> · {time(sale.createdAt)} ·{" "}
                {sale.createdBy.displayName}
                <div className="text-muted">
                  {sale.orders.flatMap((o) => o.items).map((i) => `${i.nameSnapshot}×${i.quantity}`).join(", ")}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                  {sale.status === "CANCELLED" && <span className="badge badge--danger">취소됨</span>}
                  {sale.pickupPending && <span className="badge badge--warn">수령 대기</span>}
                  {sale.refundNeeded && <span className="badge badge--danger">환불 필요</span>}
                  {sale.coupon && <span className="badge">쿠폰 {sale.coupon.code}번</span>}
                  {sale.ledger.netChargedAmount === 0 && sale.ledger.couponDiscountAmount > 0 && (
                    <span className="badge">무료 제공</span>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <strong>{formatWon(sale.ledger.netChargedAmount)}</strong>
                <div className="text-muted">매출</div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button className="btn-secondary" onClick={() => setExpanded(open ? null : sale.id)}>
                {open ? "닫기" : "상세 보기"}
              </button>
              {readyOrders.map((order) => (
                <button key={order.id} className="btn-primary" style={{ width: "auto" }} onClick={() => markPickedUp(order.id)}>
                  수령 완료 처리
                </button>
              ))}
              {role === "ADMIN" && sale.status === "COMPLETED" && (
                <button className="btn-danger-outline" onClick={() => setCancelTarget(sale)}>
                  거래 전체 취소
                </button>
              )}
            </div>

            {open && (
              <div style={{ marginTop: 12 }}>
                <CounterSaleBody sale={sale} />
                {sale.status === "CANCELLED" && (
                  <p className="text-muted">
                    {sale.cancelledAt ? time(sale.cancelledAt) : ""} · {sale.cancelledBy?.displayName} ·{" "}
                    {sale.cancelReason}
                  </p>
                )}
                {sale.refundNeeded && (
                  <p className="error-text">
                    조리 주문이 취소/거절되어 {formatWon(Math.abs(sale.ledger.remainingAmount))}을(를) 돌려드려야 해요.
                    관리자가 '거래 전체 취소'로 환불을 기록해야 정산이 마무리됩니다.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      {cancelTarget && (
        <DangerConfirmModal
          title={`#${String(cancelTarget.saleNo).padStart(3, "0")} 거래 전체 취소`}
          description="받은 금액 전액을 환불 기록으로 남기고, 조리 대기 중인 주문도 함께 취소합니다. 원본 기록은 지워지지 않습니다. 사용된 쿠폰은 '사용 완료'로 유지되며 자동으로 되살아나지 않아요 — 필요하면 새 쿠폰을 발급해 주세요."
          details={[
            { label: "실제 수납", value: formatWon(cancelTarget.ledger.netChargedAmount) },
            { label: "쿠폰 할인", value: formatWon(cancelTarget.ledger.couponDiscountAmount) },
          ]}
          requireReason
          reasonPlaceholder="취소 사유 (필수, 기록에 남습니다)"
          confirmLabel="취소하고 환불 기록"
          onConfirm={(reason) => submitCancel(cancelTarget.id, reason)}
          onCancel={() => setCancelTarget(null)}
        />
      )}

      {pendingCancel && (
        <StepUpModal
          purpose="현장 거래 전체 취소"
          mfaEnabled={mfaEnabled}
          onSuccess={() => {
            const retry = pendingCancel;
            setPendingCancel(null);
            void submitCancel(retry.id, retry.reason);
          }}
          onCancel={() => setPendingCancel(null)}
        />
      )}
    </section>
  );
}
