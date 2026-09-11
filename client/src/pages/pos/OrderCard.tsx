import type { ReactNode } from "react";
import { useNow } from "../../lib/useNow.js";

const WARN_MS = 5 * 60 * 1000; // 5분 — 임박 (추후 ADMIN 설정으로 이동 예정)
const DANGER_MS = 10 * 60 * 1000; // 10분 — 지연

export interface KdsOrder {
  id: string;
  status: string;
  note: string | null;
  createdAt: string;
  tableSession: { table: { number: number } };
  items: {
    id: string;
    nameSnapshot: string;
    quantity: number;
    options: { id: string; nameSnapshot: string }[];
  }[];
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function OrderCard({ order, actions }: { order: KdsOrder; actions: ReactNode }) {
  const now = useNow(1000);
  const elapsedMs = now - new Date(order.createdAt).getTime();
  const level = elapsedMs >= DANGER_MS ? "danger" : elapsedMs >= WARN_MS ? "warn" : "normal";

  return (
    <div className={`kds-card ${level === "danger" ? "kds-card--danger" : level === "warn" ? "kds-card--warn" : ""}`}>
      <div className="kds-card-header">
        <div>
          <div className="kds-table-number">{order.tableSession.table.number}번 테이블</div>
          <div className="kds-order-id">#{order.id.slice(-6).toUpperCase()}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="kds-elapsed">{formatElapsed(elapsedMs)} 경과</div>
          {level === "danger" && <span className="badge badge--danger">지연</span>}
          {level === "warn" && <span className="badge badge--warn">임박</span>}
        </div>
      </div>

      {order.items.map((item) => (
        <div key={item.id}>
          {item.nameSnapshot} × {item.quantity}
          {item.options.length > 0 && (
            <div className="text-muted" style={{ paddingLeft: 12 }}>
              {item.options.map((o) => (
                <div key={o.id}>- {o.nameSnapshot}</div>
              ))}
            </div>
          )}
        </div>
      ))}

      {order.note && <div className="kds-note">요청: {order.note}</div>}

      <div className="kds-actions">{actions}</div>
    </div>
  );
}
