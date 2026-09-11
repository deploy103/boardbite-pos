import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { useStaffMe } from "../../lib/useStaffMe.js";
import { useStaffSocket } from "../../lib/useStaffSocket.js";
import { useOperationSettings } from "../../lib/useOperationSettings.js";
import ReadyOrderCard from "./ReadyOrderCard.js";
import RecentlyServedCard from "./RecentlyServedCard.js";
import StaffCallPanel from "./StaffCallPanel.js";
import type { ServingOrder, StaffCall } from "./util.js";

type Tab = "ready" | "recent";

export default function ServingHome() {
  const { me } = useStaffMe("SERVING");
  const { settings } = useOperationSettings();
  const [tab, setTab] = useState<Tab>("ready");
  const [readyOrders, setReadyOrders] = useState<ServingOrder[]>([]);
  const [recentlyServed, setRecentlyServed] = useState<ServingOrder[]>([]);
  const [staffCalls, setStaffCalls] = useState<StaffCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [busyCallId, setBusyCallId] = useState<string | null>(null);
  const [revertErrors, setRevertErrors] = useState<Record<string, string>>({});

  const loadReady = useCallback(async () => {
    try {
      const data = await api.get("/api/staff/serving/ready");
      setReadyOrders(data.orders);
    } catch {
      setError("준비완료 목록을 불러오지 못했어요.");
    }
  }, []);

  const loadRecentlyServed = useCallback(async () => {
    try {
      const data = await api.get("/api/staff/serving/recently-served");
      setRecentlyServed(data.orders);
    } catch {
      setError("최근 서빙완료 목록을 불러오지 못했어요.");
    }
  }, []);

  const loadStaffCalls = useCallback(async () => {
    try {
      const data = await api.get("/api/staff/serving/staff-calls");
      setStaffCalls(data.calls);
    } catch {
      setError("직원 호출 목록을 불러오지 못했어요.");
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    loadReady();
    loadRecentlyServed();
    loadStaffCalls();
    // 소켓이 잠깐 끊겨도 화면이 멈추지 않도록 polling도 함께 유지한다(요구사항 §18 안정성).
    const interval = setInterval(() => {
      loadReady();
      loadRecentlyServed();
      loadStaffCalls();
    }, 8000);
    return () => clearInterval(interval);
  }, [me, loadReady, loadRecentlyServed, loadStaffCalls]);

  useStaffSocket("serving", (event) => {
    if (event === "order:status-changed") {
      loadReady();
      loadRecentlyServed();
    } else if (event === "staff-call:requested") {
      loadStaffCalls();
    }
  });

  async function handleServed(orderId: string) {
    setBusyOrderId(orderId);
    setError(null);
    try {
      await api.post(`/api/staff/serving/orders/${orderId}/served`);
      await Promise.all([loadReady(), loadRecentlyServed()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "서빙 완료 처리 중 오류가 발생했어요.");
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleRevert(orderId: string) {
    setBusyOrderId(orderId);
    setRevertErrors((prev) => {
      if (!(orderId in prev)) return prev;
      const next = { ...prev };
      delete next[orderId];
      return next;
    });
    try {
      await api.post(`/api/staff/serving/orders/${orderId}/revert`);
      await Promise.all([loadReady(), loadRecentlyServed()]);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "되돌리기 처리 중 오류가 발생했어요.";
      setRevertErrors((prev) => ({ ...prev, [orderId]: message }));
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleAck(callId: string) {
    setBusyCallId(callId);
    setError(null);
    try {
      await api.post(`/api/staff/serving/staff-calls/${callId}/ack`);
      await loadStaffCalls();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "호출 확인 처리 중 오류가 발생했어요.");
    } finally {
      setBusyCallId(null);
    }
  }

  async function handleDone(callId: string) {
    setBusyCallId(callId);
    setError(null);
    try {
      await api.post(`/api/staff/serving/staff-calls/${callId}/done`);
      await loadStaffCalls();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "호출 완료 처리 중 오류가 발생했어요.");
    } finally {
      setBusyCallId(null);
    }
  }

  if (!me) return null;

  const isAdmin = me.role === "ADMIN";
  const pendingCallCount = staffCalls.filter((c) => c.status === "PENDING").length;
  const groupedByTable = groupByTable(readyOrders);

  return (
    <div className="page page--wide">
      <h1>SERVING · 서빙</h1>

      {error && <p className="error-text">{error}</p>}

      <section className="serving-section">
        <div className="serving-section-header">
          <h2>직원 호출</h2>
          {pendingCallCount > 0 && <span className="badge badge--warn">대기 {pendingCallCount}건</span>}
        </div>
        <StaffCallPanel calls={staffCalls} onAck={handleAck} onDone={handleDone} busyId={busyCallId} />
      </section>

      <nav className="serving-tabs">
        <button className="btn-secondary" disabled={tab === "ready"} onClick={() => setTab("ready")}>
          준비완료 ({readyOrders.length})
        </button>
        <button className="btn-secondary" disabled={tab === "recent"} onClick={() => setTab("recent")}>
          최근 서빙완료
        </button>
      </nav>

      {tab === "ready" && (
        <div>
          {readyOrders.length === 0 && <p className="text-muted">서빙을 기다리는 준비완료 주문이 없어요.</p>}
          {groupedByTable.map((group) => (
            <div key={group.tableNumber} className="serving-table-group">
              <h3 className="serving-table-group-title">
                {group.tableNumber}번 테이블 · 미서빙 {group.orders.length}건
              </h3>
              {group.orders.map((order) => (
                <ReadyOrderCard key={order.id} order={order} onServed={handleServed} busy={busyOrderId === order.id} />
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === "recent" && (
        <div>
          {recentlyServed.length === 0 && <p className="text-muted">최근 서빙완료한 주문이 없어요.</p>}
          {recentlyServed.map((order) => (
            <RecentlyServedCard
              key={order.id}
              order={order}
              revertWindowSeconds={settings.servedRevertWindowSeconds}
              isAdmin={isAdmin}
              onRevert={handleRevert}
              busy={busyOrderId === order.id}
              error={revertErrors[order.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 테이블별 미서빙 품목을 한눈에 보기 위한 그룹화(요구사항 §2.4). 원래 READY 목록은
 * readyAt 오름차순으로 오므로, 그룹(테이블) 안의 순서와 그룹의 우선순위(가장 오래 기다린
 * 테이블이 먼저 보이도록) 모두 그 순서를 그대로 유지한다. */
function groupByTable(orders: ServingOrder[]) {
  const map = new Map<number, ServingOrder[]>();
  for (const order of orders) {
    const num = order.tableSession.table.number;
    if (!map.has(num)) map.set(num, []);
    map.get(num)!.push(order);
  }
  return Array.from(map.entries()).map(([tableNumber, tableOrders]) => ({ tableNumber, orders: tableOrders }));
}
