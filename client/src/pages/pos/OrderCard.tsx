import type { ReactNode } from "react";
import { useNow } from "../../lib/useNow.js";

export interface KdsOrder {
  id: string;
  status: string;
  note: string | null;
  createdAt: string;
  /** 테이블 주문이면 세션이, FRONT 현장 주문이면 null이다. */
  tableSession: { table: { number: number } } | null;
  /** 현장 거래 주문이면 손님에게 불러 줄 주문번호가 들어 있다. */
  counterSale?: { id: string; saleNo: number; status: string } | null;
  items: {
    id: string;
    nameSnapshot: string;
    quantity: number;
    options: { id: string; groupNameSnapshot: string | null; nameSnapshot: string; extraPriceSnapshot: number }[];
  }[];
}

/**
 * 주문의 출처 표시. 테이블 번호가 없다고 화면이 깨지면 안 된다 —
 * 현장 거래는 "현장 주문 #001"로 보여준다(요구사항.md §5.4).
 */
export function orderSourceLabel(order: Pick<KdsOrder, "tableSession" | "counterSale">): string {
  if (order.tableSession) return `${order.tableSession.table.number}번 테이블`;
  if (order.counterSale) return `현장 주문 #${String(order.counterSale.saleNo).padStart(3, "0")}`;
  return "현장 주문";
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function OrderCard({
  order,
  actions,
  warnAfterSeconds,
  dangerAfterSeconds,
}: {
  order: KdsOrder;
  actions: ReactNode;
  warnAfterSeconds: number;
  dangerAfterSeconds: number;
}) {
  const now = useNow(1000);
  const elapsedMs = now - new Date(order.createdAt).getTime();
  const level = elapsedMs >= dangerAfterSeconds * 1000 ? "danger" : elapsedMs >= warnAfterSeconds * 1000 ? "warn" : "normal";

  return (
    <div className={`kds-card ${level === "danger" ? "kds-card--danger" : level === "warn" ? "kds-card--warn" : ""}`}>
      <div className="kds-card-header">
        <div>
          <div className="kds-table-number">{orderSourceLabel(order)}</div>
          <div className="kds-order-id">#{order.id.slice(-6).toUpperCase()}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="kds-elapsed">{formatElapsed(elapsedMs)} 경과</div>
          {level === "danger" && <span className="badge badge--danger">지연</span>}
          {level === "warn" && <span className="badge badge--warn">임박</span>}
        </div>
      </div>

      {order.items.map((item) => (
        <div key={item.id} className="kds-item">
          <div className="kds-item__name">
            {item.nameSnapshot} × {item.quantity}
          </div>
          {/* 옵션은 메뉴 바로 아래에 줄바꿈 없이 잘리지 않게 전부 보여준다(요구사항.md §3.3). */}
          {item.options.length > 0 && (
            <ul className="kds-item__options">
              {item.options.map((o) => (
                <li key={o.id}>
                  {o.groupNameSnapshot ? `${o.groupNameSnapshot}: ` : ""}
                  {o.nameSnapshot}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {order.note && <div className="kds-note">요청: {order.note}</div>}

      <div className="kds-actions">{actions}</div>
    </div>
  );
}
