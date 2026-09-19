import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api.js";

/**
 * 로그인 2단계(요구사항2.md §2.5.1).
 * ID/PW만 통과한 상태에서는 아직 권한 세션이 없다 — 여기서 TOTP를 맞춰야 세션이 만들어진다.
 */
export default function StaffMfaVerify() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post("/api/staff/mfa/verify", { token });
      window.location.href = result.redirectTo ?? "/";
    } catch (err) {
      setError(errorMessage(err, "인증에 실패했어요."));
      setToken("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: "20vh" }}>
      <h1>2단계 인증</h1>
      <p className="text-muted">인증 앱에 표시된 6자리 숫자를 입력해 주세요.</p>
      <form onSubmit={onSubmit} style={{ marginTop: 24 }}>
        <input
          className="field join-code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          value={token}
          onChange={(e) => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn-primary" type="submit" disabled={submitting || token.length < 6}>
          {submitting ? "확인 중..." : "확인"}
        </button>
      </form>
    </div>
  );
}
