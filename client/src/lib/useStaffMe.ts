import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

export interface StaffMe {
  username: string;
  displayName: string;
  role: "ADMIN" | "FRONT" | "POS" | "SERVING";
  mustResetPassword: boolean;
  mfaEnabled: boolean;
  /** production ADMIN인데 아직 MFA를 켜지 않았다 — 일반 관리 기능을 쓸 수 없다. */
  mfaSetupRequired: boolean;
  /** step-up 재인증이 아직 유효한지(5분). */
  elevated: boolean;
}

/**
 * 클라이언트는 화면 표시용으로만 role을 사용한다 — 실제 인가는 항상 서버 미들웨어가 다시 검사한다.
 *
 * 온보딩이 끝나지 않은 계정(비밀번호 변경 강제 / ADMIN MFA 미설정)은 업무 화면 대신
 * 해당 설정 화면으로 보낸다(요구사항2.md §2.4, §2.5.1). 서버도 같은 조건으로 403을 내므로
 * 이 리다이렉트는 편의일 뿐 보안 경계가 아니다.
 */
export function useStaffMe(requiredRole?: StaffMe["role"]) {
  const [me, setMe] = useState<StaffMe | null | undefined>(undefined); // undefined = 로딩 중
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data: StaffMe = await api.get("/api/staff/me");
      setMe(data);
      return data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/staff/login";
        return null;
      }
      setError("사용자 정보를 불러오지 못했어요.");
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!me) return;
    if (me.mustResetPassword) {
      window.location.href = "/staff/change-password";
      return;
    }
    if (me.mfaSetupRequired) {
      window.location.href = "/staff/mfa-setup";
      return;
    }
    if (requiredRole && me.role !== requiredRole && me.role !== "ADMIN") {
      window.location.href = "/staff/login";
    }
  }, [me, requiredRole]);

  return { me, error, reload };
}
