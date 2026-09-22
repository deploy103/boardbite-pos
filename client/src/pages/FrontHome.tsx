import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, ApiError } from "../lib/api.js";
import { useStaffMe } from "../lib/useStaffMe.js";
import ConnectionBanner from "../components/ConnectionBanner.js";
import CounterSalesList from "./front/CounterSalesList.js";

interface TableRow {
  id: string;
  number: number;
  name: string | null;
  status: "DISABLED" | "AVAILABLE" | "OPEN" | "SETTLING";
  session?: { id: string; guestCount: number | null; openedAt: string; gameEndsAt: string | null };
  bill?: { totalAmount: number; paidAmount: number; remainingAmount: number };
}

interface GamePlan {
  id: string;
  name: string;
  minutes: number;
  price: number;
}

interface CloseBlocker {
  code: string;
  message: string;
  value: number;
}

/** 테이블 OPEN 직후 손님에게 읽어줄 정보 — 평문 join code는 이 순간에만 존재한다. */
interface IssuedCode {
  tableNumber: number;
  tableSessionId: string;
  joinCode: string;
  openedAt: string;
  gameEndsAt: string | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

type FrontTab = "tables" | "counter";

export default function FrontHome() {
  const { me } = useStaffMe("FRONT");
  const [tab, setTab] = useState<FrontTab>("tables");
  const [openCounterCount, setOpenCounterCount] = useState(0);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [plans, setPlans] = useState<GamePlan[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [guestCount, setGuestCount] = useState(1);
  const [planId, setPlanId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<IssuedCode | null>(null);
  const [blockedClose, setBlockedClose] = useState<{ table: TableRow; blockers: CloseBlocker[] } | null>(null);

  async function refresh() {
    const data = await api.get("/api/staff/front/tables");
    setTables(data.tables);
    // 미수령/환불 필요 현장 거래 건수를 배지로 계속 보여준다 — 마감 전에 놓치지 않게.
    try {
      const counter = await api.get("/api/staff/front/counter/sales?onlyOpen=true&limit=200");
      setOpenCounterCount(counter.sales.length);
    } catch {
      // 현장 거래 조회 실패가 테이블 현황 표시를 막지는 않는다.
    }
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

  async function handleOpen(table: TableRow) {
    try {
      setError(null);
      const result = await api.post(`/api/staff/front/tables/${table.id}/open`, {
        guestCount,
        gameTimePlanId: planId || undefined,
      });
      setOpeningId(null);
      // 서버는 평문 코드를 저장하지 않는다. 이 응답을 놓치면 재발급밖에 방법이 없다.
      setIssuedCode({
        tableNumber: table.number,
        tableSessionId: result.session.id,
        joinCode: result.joinCode,
        openedAt: result.session.openedAt,
        gameEndsAt: result.gameEndsAt,
      });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "테이블을 여는 중 오류가 발생했어요."));
    }
  }

  async function handleRotateCode(tableSessionId: string, tableNumber: number) {
    try {
      setError(null);
      const result = await api.post(`/api/staff/front/table-sessions/${tableSessionId}/rotate-join-code`, {});
      setIssuedCode({
        tableNumber,
        tableSessionId,
        joinCode: result.joinCode,
        openedAt: new Date().toISOString(),
        gameEndsAt: null,
      });
    } catch (err) {
      setError(errorMessage(err, "입장 코드를 다시 발급하지 못했어요."));
    }
  }

  /**
   * 일반 종료. 더 이상 무조건 강제 종료되지 않으므로(요구사항2.md §3.1) 서버가 409로 막으면
   * 무엇이 남았는지 그대로 보여준다. 강제 종료가 필요하면 관리자 화면에서만 가능하다.
   */
  async function handleClose(table: TableRow) {
    try {
      setError(null);
      setBlockedClose(null);
      await api.post(`/api/staff/front/tables/${table.id}/close`, {});
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CLOSE_BLOCKED") {
        setBlockedClose({ table, blockers: (err.body?.blockers as CloseBlocker[]) ?? [] });
        return;
      }
      setError(errorMessage(err, "테이블을 닫는 중 오류가 발생했어요."));
    }
  }

  if (!me) return null;

  return (
    <div className="page page--wide">
      <ConnectionBanner />
      <h1>FRONT</h1>
      <div className="front-actions">
        <Link to="/front/counter" className="btn-primary front-counter-cta">
          현장 결제 시작
        </Link>
        <span className="text-muted">테이블을 열지 않고 룰렛·보드게임·음료·조리 메뉴를 바로 판매합니다.</span>
      </div>

      <div className="seg-tabs" role="tablist">
        <button className="seg-tab" role="tab" aria-current={tab === "tables"} onClick={() => setTab("tables")}>
          테이블 현황
        </button>
        <button className="seg-tab" role="tab" aria-current={tab === "counter"} onClick={() => setTab("counter")}>
          현장 거래 {openCounterCount > 0 && <span className="badge badge--warn">{openCounterCount}</span>}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {tab === "counter" && <CounterSalesList role={me.role} mfaEnabled={me.mfaEnabled} />}
      {tab === "tables" && (
      <>
      {issuedCode && (
        <div className="join-code-card">
          <div className="table-hero__number">{issuedCode.tableNumber}번 테이블 입장 코드</div>
          <div className="join-code-value">{issuedCode.joinCode}</div>
          <div className="text-muted">손님에게 이 숫자를 안내해 주세요. 자리를 정리하면 바로 만료됩니다.</div>
          <ul className="danger-details" style={{ marginTop: 16 }}>
            <li>
              <span className="text-muted">이용 시작</span>
              <strong>{formatTime(issuedCode.openedAt)}</strong>
            </li>
            <li>
              <span className="text-muted">이용 종료 예정</span>
              <strong>{issuedCode.gameEndsAt ? formatTime(issuedCode.gameEndsAt) : "이용권 없음"}</strong>
            </li>
          </ul>
          <button className="btn-primary" onClick={() => setIssuedCode(null)}>
            확인했어요
          </button>
        </div>
      )}

      {blockedClose && (
        <div className="join-code-card" style={{ borderColor: "var(--color-danger)" }}>
          <div className="table-hero__number">{blockedClose.table.number}번 테이블을 종료할 수 없어요</div>
          <ul className="danger-details" style={{ marginTop: 16 }}>
            {blockedClose.blockers.map((b) => (
              <li key={b.code}>
                <span>{b.message}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted" style={{ fontSize: "0.85rem" }}>
            정산과 서빙을 마친 뒤 다시 시도해 주세요. 부득이하게 그대로 닫아야 한다면 관리자에게 요청하세요.
          </p>
          <button className="btn-secondary" onClick={() => setBlockedClose(null)}>
            닫기
          </button>
        </div>
      )}

      <div className="grid-tables" style={{ marginTop: 16 }}>
        {tables.map((t) => (
          <div key={t.id} className="table-card">
            <div className="table-badge">{t.number}번</div>
            <div className="text-muted">
              {t.status === "AVAILABLE" && "빈자리"}
              {/* 미수금이 음수면 초과 수납 상태다 — 결제 후 주문이 취소된 경우가 대표적이다.
                  환불을 기록해야 테이블을 닫을 수 있으므로 목록에서 바로 보이게 한다. */}
              {t.status === "OPEN" &&
                ((t.bill?.remainingAmount ?? 0) < 0
                  ? `이용중 · 환불 필요 ${Math.abs(t.bill!.remainingAmount).toLocaleString()}원`
                  : `이용중 · ${t.bill?.remainingAmount.toLocaleString()}원 미수`)}
              {t.status === "SETTLING" && "정산중"}
              {t.status === "DISABLED" && "비활성화"}
            </div>
            {(t.bill?.remainingAmount ?? 0) < 0 && <span className="badge badge--danger">환불 필요</span>}
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
                    <button className="btn-primary" onClick={() => handleOpen(t)}>
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
              <>
                <Link
                  to={`/front/checkout/${t.session.id}`}
                  className="btn-primary"
                  style={{ marginTop: 8, display: "block", textAlign: "center", textDecoration: "none" }}
                >
                  정산
                </Link>
                <button
                  className="btn-secondary"
                  style={{ marginTop: 8 }}
                  onClick={() => handleRotateCode(t.session!.id, t.number)}
                >
                  입장 코드 재발급
                </button>
              </>
            )}
            {t.status === "OPEN" && (
              <button className="btn-secondary" style={{ marginTop: 8 }} onClick={() => handleClose(t)}>
                테이블 종료
              </button>
            )}
          </div>
        ))}
      </div>
      </>
      )}
    </div>
  );
}
