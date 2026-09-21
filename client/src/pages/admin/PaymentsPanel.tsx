import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { useErrorBanner } from "./shared.js";

type Payment = {
  id: string;
  kind: "CHARGE" | "DISCOUNT" | "VOID" | "REFUND";
  method: string | null;
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number | null;
  payerLabel: string | null;
  reversedPaymentId: string | null;
  reason: string | null;
  createdAt: string;
  createdBy: { displayName: string } | null;
  tableSession: { table: { number: number } } | null;
  counterSale: { id: string; saleNo: number; status: string } | null;
};

const KIND_LABEL: Record<Payment["kind"], string> = {
  CHARGE: "결제",
  DISCOUNT: "할인",
  VOID: "취소",
  REFUND: "환불",
};

export default function PaymentsPanel() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [tableNumber, setTableNumber] = useState("");
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [searched, setSearched] = useState(false);
  const { error, setError, wrap } = useErrorBanner();

  const search = wrap(async () => {
    const params = new URLSearchParams();
    if (tableNumber) params.set("tableNumber", tableNumber);
    if (kind) params.set("kind", kind);
    if (source) params.set("source", source);
    params.set("limit", "200");
    const d = await api.get(`/api/staff/admin/payments?${params.toString()}`);
    setPayments(d.payments);
    setSearched(true);
  });

  // 다른 관리자 탭(테이블/메뉴/사용자 등)은 모두 탭을 열면 즉시 목록을 보여주므로,
  // 결제내역만 검색 버튼을 눌러야 뭔가 뜨는 건 일관성이 없다 — 필터 없이 최근 내역을 바로 보여준다.
  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section>
      <h2>결제 내역 검색</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="field"
          style={{ maxWidth: 160 }}
          placeholder="테이블 번호"
          type="number"
          value={tableNumber}
          onChange={(e) => setTableNumber(e.target.value)}
        />
        <select className="field" style={{ maxWidth: 200 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">전체 종류</option>
          <option value="CHARGE">결제</option>
          <option value="DISCOUNT">할인</option>
          <option value="VOID">취소</option>
          <option value="REFUND">환불</option>
        </select>
        <select className="field" style={{ maxWidth: 200 }} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">테이블 + 현장 전체</option>
          <option value="TABLE">테이블 정산만</option>
          <option value="COUNTER">FRONT 현장 결제만</option>
        </select>
        <button className="btn-primary" style={{ width: 120 }} onClick={search}>
          검색
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {searched && payments.length === 0 && <p className="text-muted">조건에 맞는 결제 내역이 없어요.</p>}

      {payments.map((p) => (
        <div key={p.id} className="list-row">
          <div>
            <strong>{KIND_LABEL[p.kind]}</strong> · {p.amount.toLocaleString()}원{" "}
            {p.method && <span className="badge">{p.method}</span>}{" "}
            {p.tableSession && <span className="text-muted">{p.tableSession.table.number}번 테이블</span>}
            {p.counterSale && (
              <span className="text-muted">현장 주문 #{String(p.counterSale.saleNo).padStart(3, "0")}</span>
            )}
            <div className="text-muted">
              {new Date(p.createdAt).toLocaleString()} · {p.createdBy?.displayName ?? "-"}
            </div>
            {p.tenderedAmount != null && (
              <div className="text-muted">
                받은 금액 {p.tenderedAmount.toLocaleString()}원 · 거스름돈 {(p.changeAmount ?? 0).toLocaleString()}원
              </div>
            )}
            {p.payerLabel && <div className="text-muted">지불자: {p.payerLabel}</div>}
            {p.reason && <div className="text-muted">사유: {p.reason}</div>}
            {p.reversedPaymentId && <div className="text-muted">원 결제 ID: {p.reversedPaymentId}</div>}
          </div>
        </div>
      ))}
    </section>
  );
}
