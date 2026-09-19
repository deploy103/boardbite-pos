import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api.js";

type Phase = "password" | "enroll";

/**
 * TOTP MFA 설정(요구사항2.md §2.5.1).
 *
 * 1) 현재 비밀번호를 다시 확인하고 secret을 발급받는다.
 * 2) 사용자가 인증 앱에 등록한 뒤 6자리를 한 번 맞춰야 mfaEnabled=true가 된다.
 *
 * secret은 이 화면에서만 보이고 서버 로그에도 남지 않는다. QR 이미지를 만들기 위해 외부
 * 스크립트를 불러오면 CSP(script-src 'self')를 깨뜨리므로, otpauth URI와 수동 입력용
 * secret을 그대로 보여주는 방식을 택했다.
 */
export default function StaffMfaSetup() {
  const [phase, setPhase] = useState<Phase>("password");
  const [currentPassword, setCurrentPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function startSetup(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post("/api/staff/mfa/setup", { currentPassword });
      setSecret(result.secret);
      setOtpauthUri(result.otpauthUri);
      setPhase("enroll");
    } catch (err) {
      setError(errorMessage(err, "설정을 시작하지 못했어요."));
    } finally {
      setSubmitting(false);
    }
  }

  async function finishSetup(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post("/api/staff/mfa/enable", { token });
      window.location.href = result.redirectTo ?? "/admin";
    } catch (err) {
      setError(errorMessage(err, "인증번호가 올바르지 않아요."));
      setToken("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: "10vh" }}>
      <h1>관리자 2단계 인증 설정</h1>
      <p className="text-muted">
        관리자 계정은 인증 앱(Google Authenticator, 1Password 등)으로 한 번 더 확인합니다.
      </p>

      {phase === "password" ? (
        <form onSubmit={startSetup} style={{ marginTop: 24 }}>
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            placeholder="현재 비밀번호"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
          />
          {error && <p className="error-text">{error}</p>}
          <button className="btn-primary" type="submit" disabled={submitting || !currentPassword}>
            {submitting ? "확인 중..." : "설정 시작"}
          </button>
        </form>
      ) : (
        <form onSubmit={finishSetup} style={{ marginTop: 24 }}>
          <div className="join-code-card">
            <div className="text-muted">인증 앱에 아래 키를 직접 입력하세요</div>
            <div className="join-code-value" style={{ fontSize: "1.1rem", letterSpacing: "0.1em", wordBreak: "break-all" }}>
              {secret}
            </div>
            <a href={otpauthUri} className="text-muted" style={{ fontSize: "0.85rem" }}>
              인증 앱으로 바로 등록하기
            </a>
          </div>
          <p className="text-muted" style={{ fontSize: "0.85rem" }}>
            이 키는 지금만 확인할 수 있어요. 등록을 마치기 전에 화면을 닫지 마세요.
          </p>
          <input
            className="field join-code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            value={token}
            onChange={(e) => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          {error && <p className="error-text">{error}</p>}
          <button className="btn-primary" type="submit" disabled={submitting || token.length < 6}>
            {submitting ? "확인 중..." : "2단계 인증 켜기"}
          </button>
        </form>
      )}
    </div>
  );
}
