import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api.js";

interface Me {
  displayName: string;
  role: string;
  mustResetPassword: boolean;
}

/**
 * 비밀번호 변경(요구사항2.md §2.4).
 *
 * `mustResetPassword` 계정은 서버가 다른 모든 직원 API를 403으로 막으므로, 이 화면이 사실상
 * 로그인 직후의 첫 화면이 된다. 성공하면 authVersion이 올라가 기존 세션이 모두 무효화되고
 * 서버가 새 세션을 발급하므로, 응답의 redirectTo로 이동한다.
 */
export default function StaffChangePassword() {
  const [me, setMe] = useState<Me | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get("/api/staff/me")
      .then(setMe)
      .catch(() => {
        window.location.href = "/staff/login";
      });
  }, []);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post("/api/staff/change-password", { currentPassword, newPassword });
      window.location.href = result.redirectTo ?? "/";
    } catch (err) {
      setError(errorMessage(err, "비밀번호를 변경하지 못했어요."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: "12vh" }}>
      <h1>비밀번호 변경</h1>
      {me?.mustResetPassword ? (
        <p className="text-muted">
          초기 비밀번호를 사용 중이에요. 계속하려면 먼저 새 비밀번호를 설정해 주세요.
        </p>
      ) : (
        <p className="text-muted">비밀번호를 바꾸면 이 계정의 다른 모든 기기가 로그아웃됩니다.</p>
      )}

      <form onSubmit={onSubmit} style={{ marginTop: 24 }}>
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          placeholder="현재 비밀번호"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          placeholder="새 비밀번호"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          placeholder="새 비밀번호 확인"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        <p className="text-muted" style={{ fontSize: "0.85rem" }}>
          길수록 안전합니다. 기억하기 쉬운 문장을 띄어쓰기까지 포함해 쓰는 방식을 권장해요.
        </p>
        {mismatch && <p className="error-text">새 비밀번호가 서로 달라요.</p>}
        {error && <p className="error-text">{error}</p>}
        <button
          className="btn-primary"
          type="submit"
          disabled={submitting || !currentPassword || !newPassword || mismatch}
        >
          {submitting ? "변경 중..." : "비밀번호 변경"}
        </button>
      </form>
    </div>
  );
}
