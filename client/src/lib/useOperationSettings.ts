import { useEffect, useState } from "react";
import { api } from "./api.js";

export interface OperationSettings {
  orderingEnabled: boolean;
  paymentsEnabled: boolean;
  kdsWarnAfterSeconds: number;
  kdsDangerAfterSeconds: number;
  servedRevertWindowSeconds: number;
}

// 서버(OperationSettings 모델)와 동일한 기본값. 설정을 아직 못 불러온 짧은 순간에만 사용된다.
export const DEFAULT_OPERATION_SETTINGS: OperationSettings = {
  orderingEnabled: true,
  paymentsEnabled: true,
  kdsWarnAfterSeconds: 300,
  kdsDangerAfterSeconds: 600,
  servedRevertWindowSeconds: 180,
};

/**
 * KDS 지연 기준, 서빙 되돌리기 허용 시간 등은 절대 클라이언트에 하드코딩하지 않는다.
 * ADMIN이 `/admin` 운영 설정 화면에서 바꾸면 이 훅을 쓰는 모든 화면에 반영된다.
 */
export function useOperationSettings() {
  const [settings, setSettings] = useState<OperationSettings>(DEFAULT_OPERATION_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/staff/settings")
      .then((data) => {
        if (!cancelled) {
          setSettings(data.settings);
          setLoaded(true);
        }
      })
      .catch(() => {
        /* 기본값을 계속 사용 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { settings, loaded };
}
