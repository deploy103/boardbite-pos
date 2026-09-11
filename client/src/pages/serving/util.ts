/** SERVING 화면 전용 타입/포맷 유틸. client/src/pages/pos의 KDS 타입과 겹치지만
 * "그 파일들을 직접 import하지 마라"는 지시에 따라 이 화면 전용으로 새로 정의한다.
 */

export interface ServingOrderItem {
  id: string;
  nameSnapshot: string;
  quantity: number;
  options: { id: string; nameSnapshot: string }[];
}

export interface ServingOrder {
  id: string;
  status: string;
  note: string | null;
  createdAt: string;
  readyAt: string | null;
  servedAt?: string | null;
  tableSession: { id: string; table: { number: number } };
  items: ServingOrderItem[];
}

export interface StaffCall {
  id: string;
  status: "PENDING" | "ACKED" | "DONE";
  createdAt: string;
  ackedAt: string | null;
  doneAt: string | null;
  tableSession: { id: string; table: { number: number } };
}

/** mm:ss 형태의 경과시간 표시 (KDS OrderCard와 동일한 포맷 규칙). */
export function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 오전/오후 없이 24시간 표기의 짧은 시각 표시. */
export function formatClock(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}
