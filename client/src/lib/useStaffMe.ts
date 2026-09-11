import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

export interface StaffMe {
  username: string;
  displayName: string;
  role: "ADMIN" | "FRONT" | "POS" | "SERVING";
  mustResetPassword: boolean;
}

/**
 * 클라이언트는 화면 표시용으로만 role을 사용한다 — 실제 인가는 항상 서버 미들웨어가 다시 검사한다.
 * (docs/SECURITY.md §1 — Role escalation 대응)
 */
export function useStaffMe(requiredRole?: StaffMe["role"]) {
  const [me, setMe] = useState<StaffMe | null | undefined>(undefined); // undefined = 로딩 중
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get("/api/staff/me")
      .then((data: StaffMe) => setMe(data))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = "/staff/login";
          return;
        }
        setError("사용자 정보를 불러오지 못했어요.");
      });
  }, []);

  useEffect(() => {
    if (me && requiredRole && me.role !== requiredRole && me.role !== "ADMIN") {
      window.location.href = "/staff/login";
    }
  }, [me, requiredRole]);

  return { me, error };
}
