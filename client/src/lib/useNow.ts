import { useEffect, useState } from "react";

/** KDS 경과시간 표시처럼 주기적으로 다시 그려야 하는 화면에서 사용한다. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
