import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner } from "./shared.js";

type RevenueSummary = {
  totalRevenue: number;
  totalDiscount: number;
  byMethod: { method: string; amount: number }[];
  menuSales: { menuItemId: string; name: string; quantitySold: number; revenue: number }[];
  byTable: { tableId: string; tableNumber: number; revenue: number }[];
  cancelledOrderCount: number;
  rejectedOrderCount: number;
  openTableCount: number;
};

function Bar({ label, value, max, valueLabel }: { label: string; value: number; max: number; valueLabel: string }) {
  const pct = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="revenue-bar-row">
      <div className="revenue-bar-row__label">{label}</div>
      <div className="revenue-bar-track">
        <div className="revenue-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="revenue-bar-row__value">{valueLabel}</div>
    </div>
  );
}

export default function RevenuePanel() {
  const [summary, setSummary] = useState<RevenueSummary | null>(null);
  const [range, setRange] = useState<"today" | "all" | "custom">("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const { error, setError, wrap } = useErrorBanner();

  const load = (r: "today" | "all") =>
    wrap(async () => {
      const params = new URLSearchParams();
      if (r === "today") {
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        params.set("since", since.toISOString());
      }
      const d = await api.get(`/api/staff/admin/revenue?${params.toString()}`);
      setSummary(d.summary);
      setRange(r);
    })();

  const loadCustomRange = () =>
    wrap(async () => {
      const params = new URLSearchParams();
      if (fromDate) {
        const since = new Date(fromDate);
        since.setHours(0, 0, 0, 0);
        params.set("since", since.toISOString());
      }
      if (toDate) {
        const until = new Date(toDate);
        until.setHours(23, 59, 59, 999);
        params.set("until", until.toISOString());
      }
      const d = await api.get(`/api/staff/admin/revenue?${params.toString()}`);
      setSummary(d.summary);
      setRange("custom");
    })();

  useEffect(() => {
    load("all");
  }, []);

  const methodMax = summary ? Math.max(1, ...summary.byMethod.map((m) => m.amount)) : 1;
  const tableMax = summary ? Math.max(1, ...summary.byTable.map((t) => t.revenue)) : 1;
  const menuMax = summary ? Math.max(1, ...summary.menuSales.map((m) => m.quantitySold)) : 1;

  return (
    <section>
      <h2>매출 현황</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn-secondary" onClick={() => load("today")} disabled={range === "today"}>
          오늘
        </button>
        <button className="btn-secondary" onClick={() => load("all")} disabled={range === "all"}>
          전체 기간
        </button>
        <label className="field-label" htmlFor="revenue-from-date">
          시작일
        </label>
        <input
          id="revenue-from-date"
          className="field"
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          style={{ width: "auto" }}
        />
        <label className="field-label" htmlFor="revenue-to-date">
          종료일
        </label>
        <input
          id="revenue-to-date"
          className="field"
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          style={{ width: "auto" }}
        />
        <button className="btn-secondary" onClick={loadCustomRange} disabled={!fromDate && !toDate}>
          기간 조회
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {!summary && !error && <p className="text-muted">불러오는 중이에요...</p>}

      {summary && (
        <>
          <div className="revenue-stats">
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.totalRevenue.toLocaleString()}원</div>
              <div className="revenue-stat__label">총매출</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.totalDiscount.toLocaleString()}원</div>
              <div className="revenue-stat__label">총 할인액</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.openTableCount}</div>
              <div className="revenue-stat__label">이용 중인 테이블</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.cancelledOrderCount}</div>
              <div className="revenue-stat__label">취소된 주문</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.rejectedOrderCount}</div>
              <div className="revenue-stat__label">거부된 주문</div>
            </div>
          </div>

          <h3 style={{ marginTop: 24 }}>결제수단별 매출</h3>
          {summary.byMethod.length === 0 && <p className="text-muted">결제 내역이 없어요.</p>}
          {summary.byMethod.map((m) => (
            <Bar key={m.method} label={m.method} value={m.amount} max={methodMax} valueLabel={`${m.amount.toLocaleString()}원`} />
          ))}

          <h3 style={{ marginTop: 24 }}>메뉴별 판매량 TOP</h3>
          {summary.menuSales.length === 0 && <p className="text-muted">판매 내역이 없어요.</p>}
          {summary.menuSales.map((m) => (
            <Bar
              key={m.menuItemId}
              label={m.name}
              value={m.quantitySold}
              max={menuMax}
              valueLabel={`${m.quantitySold}개 · ${m.revenue.toLocaleString()}원`}
            />
          ))}

          <h3 style={{ marginTop: 24 }}>테이블별 매출</h3>
          {summary.byTable.length === 0 && <p className="text-muted">매출 내역이 없어요.</p>}
          {summary.byTable.map((t) => (
            <Bar
              key={t.tableId}
              label={`${t.tableNumber}번`}
              value={t.revenue}
              max={tableMax}
              valueLabel={`${t.revenue.toLocaleString()}원`}
            />
          ))}
        </>
      )}
    </section>
  );
}
