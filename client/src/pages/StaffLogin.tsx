import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api.js";

export default function StaffLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.post("/api/staff/login", { username, password });
      window.location.href = result.redirectTo ?? "/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "로그인에 실패했어요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: "20vh" }}>
      <h1>BoardBite POS 직원 로그인</h1>
      <form onSubmit={onSubmit} style={{ marginTop: 24 }}>
        <input
          className="field"
          placeholder="아이디"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="field"
          placeholder="비밀번호"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn-primary" type="submit" disabled={loading || !username || !password}>
          {loading ? "로그인 중..." : "로그인하기"}
        </button>
      </form>
    </div>
  );
}
