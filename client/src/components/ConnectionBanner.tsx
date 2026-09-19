import { useConnection } from "../lib/useConnection.js";

/**
 * 서버 연결 이상을 모든 화면 상단에 동일한 형태로 알린다(요구사항2.md §9.3).
 *
 * 핵심은 "같은 버튼을 계속 누르세요"라고 유도하지 않는 것이다 — 주문/결제는 idempotency key로
 * 보호되므로, 사용자에게는 기다렸다가 화면을 새로 읽으라고만 안내한다.
 */
export default function ConnectionBanner() {
  const state = useConnection();
  if (state === "online") return null;

  const offline = state === "offline";
  return (
    <div className={`conn-banner ${offline ? "conn-banner--offline" : "conn-banner--unstable"}`} role="status">
      {offline
        ? "서버와 연결이 끊겼어요. 연결이 돌아오면 자동으로 다시 시도합니다. 같은 버튼을 반복해서 누르지 않아도 됩니다."
        : "네트워크가 불안정해요. 화면의 숫자가 최신이 아닐 수 있습니다."}
    </div>
  );
}
