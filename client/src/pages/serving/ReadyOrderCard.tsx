import { useNow } from "../../lib/useNow.js";
import { formatElapsed, type ServingOrder } from "./util.js";

/**
 * READY 상태로 얼마나 오래 대기 중인지에 대한 강조 기준.
 * KDS의 "조리 지연"(kdsWarnAfterSeconds/kdsDangerAfterSeconds)과는 의미가 다르므로
 * (요구사항 §10 "오래 READY 상태인 주문을 우선 강조") 절대 혼용하지 않는다.
 * 지금은 합리적인 고정값을 쓰고, 추후 ADMIN 운영 설정으로 분리할 수 있다.
 */
const WAIT_WARN_AFTER_SECONDS = 180; // 3분
const WAIT_DANGER_AFTER_SECONDS = 420; // 7분

export default function ReadyOrderCard({
  order,
  onServed,
  busy,
}: {
  order: ServingOrder;
  onServed: (id: string) => void;
  busy: boolean;
}) {
  const now = useNow(1000);
  const readyAtMs = order.readyAt ? new Date(order.readyAt).getTime() : now;
  const elapsedMs = now - readyAtMs;
  const level =
    elapsedMs >= WAIT_DANGER_AFTER_SECONDS * 1000 ? "danger" : elapsedMs >= WAIT_WARN_AFTER_SECONDS * 1000 ? "warn" : "normal";

  return (
    <div className={`kds-card ${level === "danger" ? "kds-card--danger" : level === "warn" ? "kds-card--warn" : ""}`}>
      <div className="kds-card-header">
        <div>
          <div className="kds-table-number">{order.tableSession.table.number}번 테이블</div>
          <div className="kds-order-id">#{order.id.slice(-6).toUpperCase()}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="kds-elapsed">준비완료 후 {formatElapsed(elapsedMs)} 경과</div>
          {level === "danger" && <span className="badge badge--danger">대기 지연</span>}
          {level === "warn" && <span className="badge badge--warn">대기 임박</span>}
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

      <div className="kds-actions">
        <button className="btn-primary" disabled={busy} onClick={() => onServed(order.id)}>
          {busy ? "처리 중…" : "서빙 완료"}
        </button>
      </div>
    </div>
  );
}
