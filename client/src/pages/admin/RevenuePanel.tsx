import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner } from "./shared.js";

type RevenueSummary = {
  totalOrderAmount: number;
  totalCharged: number;
  totalRefunded: number;
  /** 순매출 = 실제 수납 - 실제 환불. 쿠폰 액면가는 포함되지 않는다. */
  totalRevenue: number;
  manualDiscount: number;
  couponDiscount: number;
  totalDiscount: number;
  byMethod: { method: string; amount: number }[];
  byChannel: { table: number; counter: number };
  menuSales: {
    menuItemId: string;
    name: string;
    quantitySold: number;
    orderAmount: number;
    paidRevenue: number;
    couponFreeCount: number;
  }[];
  menuPaidRevenue: number;
  unallocatedCharged: number;
  byTable: { tableId: string; tableNumber: number; revenue: number }[];
  coupon: { redeemedCount: number; cancelledCount: number; amountCouponDiscount: number; itemCouponDiscount: number };
  counterSale: { completedCount: number; cancelledCount: number };
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
              <div className="revenue-stat__value">{summary.totalOrderAmount.toLocaleString()}원</div>
              <div className="revenue-stat__label">총 주문액(정가)</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.manualDiscount.toLocaleString()}원</div>
              <div className="revenue-stat__label">일반 할인</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.couponDiscount.toLocaleString()}원</div>
              <div className="revenue-stat__label">쿠폰 할인(무료 제공)</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.totalCharged.toLocaleString()}원</div>
              <div className="revenue-stat__label">실제 수납</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.totalRefunded.toLocaleString()}원</div>
              <div className="revenue-stat__label">실제 환불</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.totalRevenue.toLocaleString()}원</div>
              <div className="revenue-stat__label">순매출</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.byChannel.table.toLocaleString()}원</div>
              <div className="revenue-stat__label">테이블 순매출</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.byChannel.counter.toLocaleString()}원</div>
              <div className="revenue-stat__label">현장 순매출</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.coupon.redeemedCount}</div>
              <div className="revenue-stat__label">쿠폰 사용(취소 {summary.coupon.cancelledCount})</div>
            </div>
            <div className="revenue-stat">
              <div className="revenue-stat__value">{summary.counterSale.completedCount}</div>
              <div className="revenue-stat__label">현장 거래(취소 {summary.counterSale.cancelledCount})</div>
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

          <h3 style={{ marginTop: 24 }}>메뉴별 판매</h3>
          <p className="text-muted" style={{ fontSize: "0.85rem" }}>
            <strong>주문액</strong>은 할인 전 정가 합계이고, <strong>수납</strong>은 그 메뉴에 실제로 배분된 돈입니다.
            쿠폰으로 무료 제공한 몫은 수납에 들어가지 않아요.
          </p>
          {summary.menuSales.length === 0 && <p className="text-muted">판매 내역이 없어요.</p>}
          {summary.menuSales.map((m) => (
            <Bar
              key={m.menuItemId}
              label={m.name}
              value={m.quantitySold}
              max={menuMax}
              valueLabel={`${m.quantitySold}개 · 주문 ${m.orderAmount.toLocaleString()}원 · 수납 ${m.paidRevenue.toLocaleString()}원${
                m.couponFreeCount > 0 ? ` · 쿠폰 무료 ${m.couponFreeCount}건` : ""
              }`}
            />
          ))}
          <div className="list-row">
            <span>메뉴 배분 수납 + 미배분 수납(게임 이용료·금액 기반 결제)</span>
            <strong>
              {summary.menuPaidRevenue.toLocaleString()}원 + {summary.unallocatedCharged.toLocaleString()}원 ={" "}
              {(summary.menuPaidRevenue + summary.unallocatedCharged).toLocaleString()}원
            </strong>
          </div>
          <p className="text-muted" style={{ fontSize: "0.85rem" }}>
            이 합계는 항상 순매출과 같아야 합니다. 배분 근거가 없는 과거 결제(금액 기반 테이블 결제, 기존 게임 시간제
            이용료)는 특정 메뉴에 임의로 귀속시키지 않고 '미배분'으로 따로 보여줍니다.
          </p>

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
