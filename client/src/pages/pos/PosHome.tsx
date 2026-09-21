import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { useStaffMe } from "../../lib/useStaffMe.js";
import { useStaffSocket } from "../../lib/useStaffSocket.js";
import ConnectionBanner from "../../components/ConnectionBanner.js";
import { useOperationSettings } from "../../lib/useOperationSettings.js";
import { playBeep } from "../../lib/beep.js";
import OrderCard, { orderSourceLabel, type KdsOrder } from "./OrderCard.js";
import ReasonModal from "./ReasonModal.js";

type Board = Record<"NEW" | "ACCEPTED" | "PREPARING" | "READY", KdsOrder[]>;
type Tab = "board" | "history" | "cancelled" | "soldout";

const COLUMN_LABEL: Record<keyof Board, string> = {
  NEW: "신규",
  ACCEPTED: "접수",
  PREPARING: "조리중",
  READY: "준비완료",
};

const STATUS_LABEL: Record<string, string> = {
  NEW: "주문 확인 중",
  ACCEPTED: "접수",
  PREPARING: "조리중",
  READY: "준비완료",
  SERVED: "서빙완료",
  REJECTED: "거부됨",
  CANCELLED: "취소됨",
};

export default function PosHome() {
  const { me } = useStaffMe("POS");
  const { settings } = useOperationSettings();
  const [tab, setTab] = useState<Tab>("board");
  const [board, setBoard] = useState<Board>({ NEW: [], ACCEPTED: [], PREPARING: [], READY: [] });
  const [muted, setMuted] = useState(() => localStorage.getItem("boardbite_pos_muted") === "1");
  const [modal, setModal] = useState<{ kind: "reject" | "cancel"; orderId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prevNewCount = useRef(0);

  const loadBoard = useCallback(async () => {
    try {
      const data = await api.get("/api/staff/pos/board");
      setBoard(data.orders);
    } catch {
      setError("주문 현황을 불러오지 못했어요.");
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    loadBoard();
    const interval = setInterval(loadBoard, 8000);
    return () => clearInterval(interval);
  }, [me, loadBoard]);

  useEffect(() => {
    if (board.NEW.length > prevNewCount.current && !muted) {
      playBeep();
    }
    prevNewCount.current = board.NEW.length;
  }, [board.NEW.length, muted]);

  useStaffSocket(() => {
    loadBoard();
  });

  function toggleMute() {
    setMuted((prev) => {
      const next = !prev;
      localStorage.setItem("boardbite_pos_muted", next ? "1" : "0");
      return next;
    });
  }

  async function runAction(path: string, body?: unknown) {
    try {
      await api.post(path, body ?? {});
      await loadBoard();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "처리 중 오류가 발생했어요.");
    }
  }

  function closeModal() {
    setModal(null);
  }

  async function confirmModal(reason: string) {
    if (!modal) return;
    const path =
      modal.kind === "reject" ? `/api/staff/pos/orders/${modal.orderId}/reject` : `/api/staff/pos/orders/${modal.orderId}/cancel`;
    await runAction(path, { reason });
    closeModal();
  }

  if (!me) return null;

  return (
    <div className="page page--wide">
      <ConnectionBanner />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>POS · 주방(KDS)</h1>
        <button className="btn-secondary" onClick={toggleMute}>
          {muted ? "🔇 알림음 꺼짐" : "🔔 알림음 켜짐"}
        </button>
      </div>

      <nav style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        {(["board", "history", "cancelled", "soldout"] as Tab[]).map((t) => (
          <button key={t} className="btn-secondary" onClick={() => setTab(t)} disabled={tab === t}>
            {t === "board" && "주문 보드"}
            {t === "history" && "이력"}
            {t === "cancelled" && "거부/취소"}
            {t === "soldout" && "품절 처리"}
          </button>
        ))}
      </nav>

      {error && <p className="error-text">{error}</p>}

      {tab === "board" && (
        <div className="kds-columns">
          {(Object.keys(COLUMN_LABEL) as (keyof Board)[]).map((status) => (
            <div key={status} className="kds-column">
              <h2>
                {COLUMN_LABEL[status]} ({board[status].length})
              </h2>
              {board[status].map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  warnAfterSeconds={settings.kdsWarnAfterSeconds}
                  dangerAfterSeconds={settings.kdsDangerAfterSeconds}
                  actions={
                    <>
                      {status === "NEW" && (
                        <>
                          <button className="btn-secondary" onClick={() => setModal({ kind: "reject", orderId: order.id })}>
                            거부
                          </button>
                          <button className="btn-primary" onClick={() => runAction(`/api/staff/pos/orders/${order.id}/accept`)}>
                            접수
                          </button>
                        </>
                      )}
                      {status === "ACCEPTED" && (
                        <button
                          className="btn-primary"
                          onClick={() => runAction(`/api/staff/pos/orders/${order.id}/start-preparing`)}
                        >
                          조리 시작
                        </button>
                      )}
                      {status === "PREPARING" && (
                        <button className="btn-primary" onClick={() => runAction(`/api/staff/pos/orders/${order.id}/ready`)}>
                          준비완료
                        </button>
                      )}
                      {status === "READY" && <span className="badge">서빙 대기</span>}
                      {(status === "NEW" || status === "ACCEPTED" || status === "PREPARING") && (
                        <button className="btn-secondary" onClick={() => setModal({ kind: "cancel", orderId: order.id })}>
                          취소
                        </button>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === "history" && <HistoryPanel />}
      {tab === "cancelled" && <HistoryPanel forcedStatus="CANCELLED" />}
      {tab === "soldout" && <SoldOutPanel />}

      {modal && (
        <ReasonModal
          title={modal.kind === "reject" ? "주문을 거부할까요?" : "주문을 취소할까요?"}
          onCancel={closeModal}
          onConfirm={confirmModal}
        />
      )}
    </div>
  );
}

function HistoryPanel({ forcedStatus }: { forcedStatus?: string }) {
  const [status, setStatus] = useState(forcedStatus ?? "");
  const [tableNumber, setTableNumber] = useState("");
  const [orders, setOrders] = useState<(KdsOrder & { status: string })[]>([]);

  const search = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (tableNumber) params.set("tableNumber", tableNumber);
    const data = await api.get(`/api/staff/pos/history?${params.toString()}`);
    setOrders(data.orders);
  }, [status, tableNumber]);

  useEffect(() => {
    search();
  }, [search]);

  return (
    <div>
      {!forcedStatus && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <select className="field" style={{ marginBottom: 0 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">전체 상태</option>
            {Object.keys(STATUS_LABEL).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <input
            className="field"
            style={{ marginBottom: 0 }}
            placeholder="테이블 번호"
            value={tableNumber}
            onChange={(e) => setTableNumber(e.target.value)}
          />
          <button className="btn-secondary" onClick={search}>
            검색
          </button>
        </div>
      )}
      {orders.map((order) => (
        <div key={order.id} className="table-card" style={{ marginBottom: 12 }}>
          <div className="kds-card-header">
            <div>
              <strong>{orderSourceLabel(order)}</strong> · <span className="kds-order-id">#{order.id.slice(-6).toUpperCase()}</span>
            </div>
            <span className="badge">{STATUS_LABEL[order.status] ?? order.status}</span>
          </div>
          {order.items.map((item) => (
            <div key={item.id}>
              {item.nameSnapshot} × {item.quantity}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SoldOutPanel() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await api.get("/api/staff/pos/menu-items");
    setItems(data.items);
  }, []);

  useEffect(() => {
    refresh().catch(() => setError("메뉴를 불러오지 못했어요."));
  }, [refresh]);

  async function toggle(id: string, current: boolean) {
    try {
      await api.patch(`/api/staff/pos/menu-items/${id}/sold-out`, { isSoldOut: !current });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "처리 중 오류가 발생했어요.");
    }
  }

  return (
    <div>
      {error && <p className="error-text">{error}</p>}
      {items.map((item) => (
        <div key={item.id} className={`list-row ${item.isSoldOut ? "list-row--disabled" : ""}`}>
          <div>
            {item.name} · {item.price.toLocaleString()}원 {item.isSoldOut && <span className="badge badge--danger">품절</span>}
          </div>
          <button className="btn-secondary" onClick={() => toggle(item.id, item.isSoldOut)}>
            {item.isSoldOut ? "품절 해제" : "품절 처리"}
          </button>
        </div>
      ))}
    </div>
  );
}
