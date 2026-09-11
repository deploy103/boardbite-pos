import { useNow } from "../../lib/useNow.js";
import { formatClock, type StaffCall } from "./util.js";

const STATUS_LABEL: Record<StaffCall["status"], string> = {
  PENDING: "대기중",
  ACKED: "확인함",
  DONE: "완료",
};

export default function StaffCallPanel({
  calls,
  onAck,
  onDone,
  busyId,
}: {
  calls: StaffCall[];
  onAck: (id: string) => void;
  onDone: (id: string) => void;
  busyId: string | null;
}) {
  const now = useNow(1000);

  if (calls.length === 0) {
    return <p className="text-muted">대기 중인 직원 호출이 없어요.</p>;
  }

  return (
    <div>
      {calls.map((call) => {
        const elapsedSeconds = Math.max(0, Math.floor((now - new Date(call.createdAt).getTime()) / 1000));
        const m = Math.floor(elapsedSeconds / 60);
        const s = elapsedSeconds % 60;
        return (
          <div key={call.id} className="serving-call-row list-row">
            <div>
              <strong>{call.tableSession.table.number}번 테이블</strong>{" "}
              <span className={`badge ${call.status === "PENDING" ? "badge--warn" : ""}`}>{STATUS_LABEL[call.status]}</span>
              <div className="text-caption">
                {formatClock(call.createdAt)} 요청 · {m}:{s.toString().padStart(2, "0")} 경과
              </div>
            </div>
            {call.status === "PENDING" && (
              <button className="btn-secondary" disabled={busyId === call.id} onClick={() => onAck(call.id)}>
                {busyId === call.id ? "처리 중…" : "확인"}
              </button>
            )}
            {call.status === "ACKED" && (
              <button className="btn-secondary" disabled={busyId === call.id} onClick={() => onDone(call.id)}>
                {busyId === call.id ? "처리 중…" : "완료"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
