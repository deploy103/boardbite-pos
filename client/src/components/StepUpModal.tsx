import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api.js";

interface Props {
  /** 무엇을 하기 위한 재인증인지 — 사용자가 맥락을 알 수 있게 그대로 보여준다. */
  purpose: string;
  /** MFA를 쓰는 계정이면 TOTP 입력칸도 함께 띄운다. */
  mfaEnabled: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * 고위험 작업 직전의 재인증(요구사항2.md §2.5.2).
 * 성공하면 5분간 유효한 `elevatedUntil`이 세션에 기록되고, 서버가 그 창 안에서만 작업을 허용한다.
 */
export default function StepUpModal({ purpose, mfaEnabled, onSuccess, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/api/staff/step-up", { password, token: token || undefined });
      onSuccess();
    } catch (err) {
      setError(errorMessage(err, "재인증에 실패했어요."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sheet-overlay" onClick={onCancel}>
      <div className="sheet danger-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <h2 className="sheet-title">보안 확인</h2>
          <button type="button" className="sheet-close" onClick={onCancel}>
            닫기
          </button>
        </div>
        <p className="sheet-desc">
          <strong>{purpose}</strong>은(는) 되돌리기 어려운 작업이에요. 본인 확인을 위해 비밀번호를 다시 입력해 주세요.
        </p>
        <form onSubmit={onSubmit}>
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            placeholder="현재 비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {mfaEnabled && (
            <input
              className="field"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="인증 앱 6자리"
              value={token}
              onChange={(e) => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          )}
          {error && <p className="error-text">{error}</p>}
          <button className="btn-danger" type="submit" disabled={submitting || !password || (mfaEnabled && token.length < 6)}>
            {submitting ? "확인 중..." : "확인하고 계속"}
          </button>
        </form>
      </div>
    </div>
  );
}
