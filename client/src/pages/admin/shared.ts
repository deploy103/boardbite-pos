import { useCallback, useState } from "react";
import { ApiError, errorMessage } from "../../lib/api.js";

/** AdminHome.tsx의 기존 패널들과 동일한 에러 배너 훅. 새 관리자 패널에서 재사용한다. */
export function useErrorBanner() {
  const [error, setError] = useState<string | null>(null);
  const wrap = (fn: () => Promise<void>) => async () => {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return { error, setError, wrap };
}

export interface PendingStepUp {
  purpose: string;
  retry: () => Promise<void>;
}

/**
 * 고위험 작업용 step-up 가드(요구사항2.md §2.5.2).
 *
 * 화면이 "이 작업은 재인증이 필요하다"를 미리 알 필요가 없다 — 그냥 호출하고, 서버가
 * 403 STEP_UP_REQUIRED로 거절하면 비밀번호 확인 창을 띄운 뒤 **같은 작업을 그대로 다시**
 * 실행한다. 재인증 창은 5분간 유효하므로 연속 작업에서는 한 번만 뜬다.
 */
export function useStepUpGuard() {
  const [pending, setPending] = useState<PendingStepUp | null>(null);

  const guard = useCallback(async (purpose: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === "STEP_UP_REQUIRED") {
        setPending({ purpose, retry: action });
        return;
      }
      throw err;
    }
  }, []);

  return { pending, setPending, guard };
}

/**
 * 역할별 비밀번호 최소 길이 — 입력 전에 안내하기 위한 값이다.
 * 실제 강제는 서버(server/src/auth/passwordPolicy.ts)가 하며 그쪽이 단일 출처다.
 * ADMIN이 더 긴 이유: 관리자 계정은 모든 운영 기능과 사용자 관리 권한을 함께 쥐고 있다.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 15;
export const MIN_STAFF_PASSWORD_LENGTH = 10;

export function minPasswordLength(role: string | undefined): number {
  return role === "ADMIN" ? MIN_ADMIN_PASSWORD_LENGTH : MIN_STAFF_PASSWORD_LENGTH;
}
