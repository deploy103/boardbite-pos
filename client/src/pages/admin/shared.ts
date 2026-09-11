import { useState } from "react";
import { ApiError } from "../../lib/api.js";

/** AdminHome.tsx의 기존 패널들과 동일한 에러 배너 훅. 새 관리자 패널에서 재사용한다. */
export function useErrorBanner() {
  const [error, setError] = useState<string | null>(null);
  const wrap = (fn: () => Promise<void>) => async () => {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "요청 처리 중 오류가 발생했어요.");
    }
  };
  return { error, setError, wrap };
}
