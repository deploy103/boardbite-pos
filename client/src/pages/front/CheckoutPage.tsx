import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import { useStaffMe } from "../../lib/useStaffMe.js";
import { useStaffSocket } from "../../lib/useStaffSocket.js";
import { formatWon } from "./format.js";
import AmountPaymentPanel from "./AmountPaymentPanel.js";
import DutchSplitPanel from "./DutchSplitPanel.js";
import ItemSplitPanel from "./ItemSplitPanel.js";
import PaymentHistoryList from "./PaymentHistoryList.js";
import VoidReasonModal from "./VoidReasonModal.js";
import DiscountModal from "./DiscountModal.js";
import type { CheckoutData, PaymentMethod, PaymentRow, Settlement } from "./types.js";

type Tab = "amount" | "dutch" | "items";

/**
 * FRONT 정산 화면(요구사항.md §12, docs/ARCHITECTURE.md §5.4/§6/§8).
 * 서버가 결제/정산의 단일 진실 공급원이다 — 이 화면은 항상 GET .../checkout을 다시 불러와 반영하고,
 * 소켓 이벤트는 "다시 불러올 시점"을 알려주는 트리거로만 쓴다.
 */
export default function CheckoutPage() {
  const { me } = useStaffMe("FRONT");
  const { tableSessionId } = useParams<{ tableSessionId: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<CheckoutData | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("amount");

  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountSubmitting, setDiscountSubmitting] = useState(false);
  const [voidTarget, setVoidTarget] = useState<PaymentRow | null>(null);
  const [voidSubmitting, setVoidSubmitting] = useState(false);

  const [closedOverlay, setClosedOverlay] = useState(false);
  const [pendingNotice, setPendingNotice] = useState(false);

  const refresh = useCallback(async () => {
    if (!tableSessionId) return;
    const result = await api.get(`/api/staff/front/table-sessions/${tableSessionId}/checkout`);
    setData(result);
  }, [tableSessionId]);

  useEffect(() => {
    if (!me || !tableSessionId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.get("/api/staff/front/payment-methods").then((d) => setMethods(d.methods)), refresh()])
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "정산 정보를 불러오지 못했어요.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [me, tableSessionId, refresh]);

  useStaffSocket("front", (event) => {
    if (event === "payment:recorded" || event === "order:created" || event === "order:status-changed") {
      refresh().catch(() => undefined);
    }
  });

  function handleSettlement(settlement: Settlement) {
    setActionError(null);
    refresh().catch(() => setLoadError("정산 정보를 새로고침하지 못했어요."));
    if (settlement === "CLOSED") {
      setClosedOverlay(true);
      window.setTimeout(() => navigate("/front"), 2500);
    } else if (settlement === "PENDING_SERVICE") {
      setPendingNotice(true);
    }
  }

  async function handleDiscount(amount: number, reason: string) {
    if (!tableSessionId) return;
    setDiscountSubmitting(true);
    try {
      const result = await api.post(`/api/staff/front/table-sessions/${tableSessionId}/discount`, {
        idempotencyKey: crypto.randomUUID(),
        amount,
        reason,
      });
      setDiscountOpen(false);
      handleSettlement(result.settlement);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "할인 적용 중 오류가 발생했어요.");
    } finally {
      setDiscountSubmitting(false);
    }
  }

  async function handleVoid(reason: string) {
    if (!voidTarget) return;
    setVoidSubmitting(true);
    try {
      const result = await api.post(`/api/staff/front/payments/${voidTarget.id}/void`, { reason });
      setVoidTarget(null);
      handleSettlement(result.settlement);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "결제 취소 중 오류가 발생했어요.");
    } finally {
      setVoidSubmitting(false);
    }
  }

  if (!me) return null;

  if (loading) {
    return (
      <div className="page page--wide">
        <div className="loading-center">정산 정보를 불러오는 중이에요...</div>
      </div>
    );
  }

  if (loadError || !data || !tableSessionId) {
    return (
      <div className="page page--wide">
        <div className="error-panel">{loadError ?? "정산 정보를 찾을 수 없어요."}</div>
        <Link to="/front" className="btn-secondary" style={{ marginTop: 16, display: "inline-block" }}>
          테이블 목록으로
        </Link>
      </div>
    );
  }

  const { table, session, bill, orders, payments } = data;
  const isRefundNeeded = bill.remainingAmount < 0;

  return (
    <div className="page page--wide">
      {closedOverlay && (
        <div className="checkout-closed-overlay">
          <div className="checkout-closed-card">
            <h2>정산이 완료됐어요</h2>
            <p className="text-muted">잠시 후 테이블 목록으로 돌아가요.</p>
            <button className="btn-primary" onClick={() => navigate("/front")}>
              지금 이동하기
            </button>
          </div>
        </div>
      )}

      <div className="checkout-header">
        <div>
          <Link to="/front" className="text-muted">
            ← 테이블 목록
          </Link>
          <h1>{table.number}번 테이블 정산</h1>
        </div>
        <span className="badge">{session.status === "PAID_PENDING_SERVICE" ? "완납 · 서빙 대기" : "정산 중"}</span>
      </div>

      {session.status === "PAID_PENDING_SERVICE" && (
        <p className="checkout-notice">완납했지만 아직 서빙 중인 메뉴가 있어요. 서빙이 끝나면 자동으로 마감돼요.</p>
      )}
      {pendingNotice && (
        <p className="checkout-notice">
          결제가 완료됐어요. 아직 준비 중인 메뉴가 있어 서빙이 끝나면 자동으로 마감돼요.
        </p>
      )}
      {isRefundNeeded && (
        <div className="checkout-refund-banner">환불이 필요해요 · {formatWon(Math.abs(bill.remainingAmount))}</div>
      )}
      {actionError && <p className="error-text">{actionError}</p>}

      <div className="bill-card">
        <div className="bill-card__row">
          <span>총 주문금액</span>
          <span>{formatWon(bill.totalAmount)}</span>
        </div>
        <div className="bill-card__row">
          <span>할인금액</span>
          <span>{formatWon(bill.discountAmount)}</span>
        </div>
        <div className="bill-card__row">
          <span>이미 결제한 금액</span>
          <span>{formatWon(bill.paidAmount)}</span>
        </div>
        <div className="bill-card__row bill-card__row--total">
          <span>{isRefundNeeded ? "환불 필요 금액" : "남은 금액"}</span>
          <span>{formatWon(Math.abs(bill.remainingAmount))}</span>
        </div>
      </div>

      <button className="btn-secondary checkout-discount-btn" onClick={() => setDiscountOpen(true)}>
        할인 적용
      </button>

      <div className="seg-tabs" role="tablist">
        <button className="seg-tab" role="tab" aria-current={tab === "amount"} onClick={() => setTab("amount")}>
          금액으로 결제
        </button>
        <button className="seg-tab" role="tab" aria-current={tab === "dutch"} onClick={() => setTab("dutch")}>
          더치페이
        </button>
        <button className="seg-tab" role="tab" aria-current={tab === "items"} onClick={() => setTab("items")}>
          상품별 결제
        </button>
      </div>

      {tab === "amount" && (
        <AmountPaymentPanel
          tableSessionId={tableSessionId}
          methods={methods}
          remainingAmount={bill.remainingAmount}
          onSubmitted={handleSettlement}
          onError={setActionError}
        />
      )}
      {tab === "dutch" && (
        <DutchSplitPanel
          tableSessionId={tableSessionId}
          methods={methods}
          remainingAmount={bill.remainingAmount}
          onSubmitted={handleSettlement}
          onError={setActionError}
        />
      )}
      {tab === "items" && (
        <ItemSplitPanel
          tableSessionId={tableSessionId}
          methods={methods}
          orders={orders}
          onSubmitted={handleSettlement}
          onError={setActionError}
        />
      )}

      <h2 className="checkout-section-title">결제 내역</h2>
      <PaymentHistoryList payments={payments} onVoid={setVoidTarget} />

      {discountOpen && (
        <DiscountModal
          remainingAmount={Math.max(bill.remainingAmount, 0)}
          submitting={discountSubmitting}
          onCancel={() => setDiscountOpen(false)}
          onConfirm={handleDiscount}
        />
      )}
      {voidTarget && (
        <VoidReasonModal
          amountLabel={formatWon(voidTarget.amount)}
          submitting={voidSubmitting}
          onCancel={() => setVoidTarget(null)}
          onConfirm={handleVoid}
        />
      )}
    </div>
  );
}
