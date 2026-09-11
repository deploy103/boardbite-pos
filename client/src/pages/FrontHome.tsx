import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api.js";
import { useStaffMe } from "../lib/useStaffMe.js";

interface TableRow {
  id: string;
  number: number;
  name: string | null;
  status: "DISABLED" | "AVAILABLE" | "OPEN" | "SETTLING";
  session?: { id: string; guestCount: number | null; gameEndsAt: string | null };
  bill?: { totalAmount: number; paidAmount: number; remainingAmount: number };
}

interface GamePlan {
  id: string;
  name: string;
  minutes: number;
  price: number;
}

export default function FrontHome() {
  const { me } = useStaffMe("FRONT");
  const [tables, setTables] = useState<TableRow[]>([]);
  const [plans, setPlans] = useState<GamePlan[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [guestCount, setGuestCount] = useState(1);
  const [planId, setPlanId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const data = await api.get("/api/staff/front/tables");
    setTables(data.tables);
  }

  useEffect(() => {
    if (!me) return;
    refresh().catch(() => setError("테이블 현황을 불러오지 못했어요."));
    api
      .get("/api/staff/front/game-plans")
      .then((data) => setPlans(data.plans))
      .catch(() => setError("이용권 목록을 불러오지 못했어요."));
    const interval = setInterval(() => refresh().catch(() => undefined), 15000);
    return () => clearInterval(interval);
  }, [me]);

  async function handleOpen(tableId: string) {
    try {
      await api.post(`/api/staff/front/tables/${tableId}/open`, {
        guestCount,
        gameTimePlanId: planId || undefined,
      });
      setOpeningId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "테이블을 여는 중 오류가 발생했어요.");
    }
  }

  async function handleClose(tableId: string) {
    if (!confirm("이 테이블을 종료할까요? (정산이 끝나지 않았다면 먼저 확인해 주세요)")) return;
    try {
      await api.post(`/api/staff/front/tables/${tableId}/close`, {});
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "테이블을 닫는 중 오류가 발생했어요.");
    }
  }

  if (!me) return null;

  return (
    <div className="page page--wide">
      <h1>FRONT · 테이블 현황</h1>
      {error && <p className="error-text">{error}</p>}
      <div className="grid-tables" style={{ marginTop: 16 }}>
        {tables.map((t) => (
          <div key={t.id} className="table-card">
            <div className="table-badge">{t.number}번</div>
            <div className="text-muted">
              {t.status === "AVAILABLE" && "빈자리"}
              {t.status === "OPEN" && `이용중 · ${t.bill?.remainingAmount.toLocaleString()}원 미수`}
              {t.status === "SETTLING" && "정산중"}
              {t.status === "DISABLED" && "비활성화"}
            </div>
            {t.status === "AVAILABLE" && (
              <>
                {openingId === t.id ? (
                  <div style={{ marginTop: 8 }}>
                    <input
                      className="field"
                      type="number"
                      min={1}
                      value={guestCount}
                      onChange={(e) => setGuestCount(Number(e.target.value))}
                      placeholder="인원수"
                    />
                    <select className="field" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                      <option value="">이용권 선택 안 함</option>
                      {plans.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.price.toLocaleString()}원)
                        </option>
                      ))}
                    </select>
                    <button className="btn-primary" onClick={() => handleOpen(t.id)}>
                      테이블 열기
                    </button>
                  </div>
                ) : (
                  <button className="btn-secondary" style={{ marginTop: 8 }} onClick={() => setOpeningId(t.id)}>
                    자리 배정
                  </button>
                )}
              </>
            )}
            {(t.status === "OPEN" || t.status === "SETTLING") && t.session && (
              <Link
                to={`/front/checkout/${t.session.id}`}
                className="btn-primary"
                style={{ marginTop: 8, display: "block", textAlign: "center", textDecoration: "none" }}
              >
                정산
              </Link>
            )}
            {t.status === "OPEN" && (
              <button className="btn-secondary" style={{ marginTop: 8 }} onClick={() => handleClose(t.id)}>
                테이블 종료
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
