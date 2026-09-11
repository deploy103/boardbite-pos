import { useNow } from "../../lib/useNow.js";
import { formatClock, type ServingOrder } from "./util.js";

export default function RecentlyServedCard({
  order,
  revertWindowSeconds,
  isAdmin,
  onRevert,
  busy,
  error,
}: {
  order: ServingOrder;
  revertWindowSeconds: number;
  isAdmin: boolean;
  onRevert: (id: string) => void;
  busy: boolean;
  error?: string;
}) {
  const now = useNow(1000);
  const servedAtMs = order.servedAt ? new Date(order.servedAt).getTime() : now;
  const elapsedSeconds = Math.max(0, Math.floor((now - servedAtMs) / 1000));
  // 최종 판단은 항상 서버가 한다 — 여기서는 버튼을 미리 비활성화해서 불필요한 403 요청을 줄이는 용도일 뿐이다.
  const windowExpired = !isAdmin && elapsedSeconds > revertWindowSeconds;

  return (
    <div className="kds-card">
      <div className="kds-card-header">
        <div>
          <div className="kds-table-number">{order.tableSession.table.number}번 테이블</div>
          <div className="kds-order-id">#{order.id.slice(-6).toUpperCase()}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="kds-elapsed">{order.servedAt ? formatClock(order.servedAt) : ""} 서빙완료</div>
          <span className="badge">서빙완료</span>
        </div>
      </div>

      {order.items.map((item) => (
        <div key={item.id}>
          {item.nameSnapshot} × {item.quantity}
        </div>
      ))}

      <div className="kds-actions">
        <button className="btn-secondary" disabled={busy || windowExpired} onClick={() => onRevert(order.id)}>
          {busy ? "처리 중…" : "되돌리기"}
        </button>
      </div>
      {windowExpired && <p className="serving-revert-expired">되돌릴 수 있는 시간이 지났어요.</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
