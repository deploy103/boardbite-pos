import { useState, type FormEvent } from "react";
import { api, errorMessage } from "../../lib/api.js";

interface Props {
  slug: string;
  tableNumber: number | null;
  onJoined: () => void;
}

/**
 * 손님 입장 코드 화면(요구사항2.md §2.2).
 *
 * QR/NFC에 들어 있는 주소(`/t/<slug>`)는 "몇 번 테이블인가"만 알려준다. 예전에 저장해 둔
 * 링크를 다시 열어도 이 화면에서 멈추며, 직원에게 받은 이번 자리의 코드를 입력해야만
 * 서버가 이 기기에 접근 권한(device session 쿠키)을 발급한다.
 */
export default function JoinCodeGate({ slug, tableNumber, onJoined }: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/customer/join/${slug}`, { joinCode: code });
      onJoined();
    } catch (err) {
      setError(errorMessage(err, "입장하지 못했어요. 잠시 후 다시 시도해 주세요."));
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page" style={{ paddingTop: "14vh", textAlign: "center" }}>
      {tableNumber !== null && <div className="table-hero__number">{tableNumber}번 테이블</div>}
      <h1 style={{ marginTop: 16 }}>입장 코드를 입력해 주세요</h1>
      <p className="text-muted">직원에게 안내받은 이번 자리의 6자리 숫자예요.</p>

      <form onSubmit={onSubmit} style={{ marginTop: 24 }}>
        <input
          className="field join-code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn-primary" type="submit" disabled={submitting || code.length < 6}>
          {submitting ? "확인 중..." : "입장하기"}
        </button>
      </form>

      <p className="text-muted" style={{ marginTop: 24, fontSize: "0.85rem" }}>
        코드를 모르시면 직원을 불러 주세요. 자리를 정리하면 코드는 바로 만료됩니다.
      </p>
    </div>
  );
}
