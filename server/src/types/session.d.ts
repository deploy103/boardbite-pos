import "express-session";

declare module "express-session" {
  interface SessionData {
    staffUserId?: string;
    /**
     * 로그인 시점의 StaffUser.authVersion. 매 요청마다 DB 값과 비교해 다르면 즉시 401로 만든다
     * (요구사항2.md §2.3 — 권한 변경/비활성화/비밀번호 변경 시 기존 세션 무효화).
     */
    authVersion?: number;
    /** 화면 표시/리다이렉트 편의를 위한 캐시일 뿐, 인가 판단에는 절대 사용하지 않는다. */
    role?: "ADMIN" | "FRONT" | "POS" | "SERVING";
    /** ID/PW는 통과했지만 아직 TOTP를 넘지 않은 중간 상태(요구사항2.md §2.5.1). */
    pendingMfaUserId?: string;
    pendingMfaStartedAt?: number;
    /**
     * 이 pending 상태에서 TOTP를 틀린 횟수. 한도를 넘으면 pending을 폐기해
     * 비밀번호부터 다시 입력하게 만든다 — TOTP 6자리 무차별 대입 차단.
     */
    pendingMfaFailures?: number;
    /** step-up 재인증 만료 시각(epoch ms). 요구사항2.md §2.5.2 — 5분. */
    elevatedUntil?: number;
    /** step-up 재인증 실패 횟수. 한도를 넘으면 세션 자체를 끊는다. */
    stepUpFailures?: number;
  }
}

declare global {
  namespace Express {
    interface Request {
      /** 요구사항2.md §2.2 — 손님 device session 쿠키에서 유도된 현재 활성 테이블 세션 */
      tableSession?: {
        id: string;
        tableId: string;
        tableNumber: number;
        sessionStatus: "ACTIVE" | "PAID_PENDING_SERVICE";
        tableOrdersLocked: boolean;
        deviceSessionId: string;
      };
      /** 매 요청마다 DB에서 다시 읽은 직원 정보. 인가 판단은 오직 이 값만 사용한다. */
      staff?: {
        id: string;
        username: string;
        displayName: string;
        role: "ADMIN" | "FRONT" | "POS" | "SERVING";
        isActive: boolean;
        mustResetPassword: boolean;
        mfaEnabled: boolean;
        authVersion: number;
      };
      /** 서버 로그와 클라이언트 오류 응답을 이어주는 추적용 ID(요구사항2.md §6.2). */
      requestId?: string;
    }
  }
}

export {};
