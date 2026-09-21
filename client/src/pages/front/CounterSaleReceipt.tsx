import { formatWon } from "./format.js";
import { ORDER_STATUS_LABEL, type CounterSaleDetail } from "./counterTypes.js";

const time = (iso: string) => new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

/** 주문 항목 하나 + 그 아래에 옵션을 빠짐없이 보여준다(요구사항.md §3.3). */
export function SaleItemLines({ items }: { items: CounterSaleDetail["orders"][number]["items"] }) {
  return (
    <>
      {items.map((item) => (
        <div key={item.id} className="counter-sale-item">
          <div className="counter-sale-item__name">
            {item.nameSnapshot} × {item.quantity}
            <span className="counter-sale-item__price">
              {formatWon((item.unitPrice + item.options.reduce((s, o) => s + o.extraPriceSnapshot, 0)) * item.quantity)}
            </span>
          </div>
          {item.options.length > 0 && (
            <ul className="counter-sale-options">
              {item.options.map((option) => (
                <li key={option.id}>
                  {option.groupNameSnapshot ? `${option.groupNameSnapshot}: ` : ""}
                  {option.nameSnapshot}
                  <span className="counter-sale-options__price">+{option.extraPriceSnapshot.toLocaleString()}원</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}

/** 거래 상세 본문. 결제 직후 화면과 거래 이력에서 같은 컴포넌트를 쓴다. */
export function CounterSaleBody({ sale }: { sale: CounterSaleDetail }) {
  return (
    <>
      {sale.orders.map((order) => (
        <div key={order.id} className="counter-sale-order">
          <div className="counter-sale-order__head">
            <span className="badge">{order.servingMode === "KITCHEN" ? "주방 조리" : "현장 제공"}</span>
            <span className={order.status === "READY" ? "badge badge--warn" : "badge"}>
              {ORDER_STATUS_LABEL[order.status] ?? order.status}
            </span>
            {order.rejectReason && <span className="text-muted">거절 사유: {order.rejectReason}</span>}
            {order.cancelReason && <span className="text-muted">취소 사유: {order.cancelReason}</span>}
          </div>
          <SaleItemLines items={order.items} />
        </div>
      ))}

      <div className="bill-card">
        <div className="bill-card__row">
          <span>주문 금액</span>
          <span>{formatWon(sale.ledger.orderAmount)}</span>
        </div>
        {sale.coupon && (
          <div className="bill-card__row">
            <span>
              쿠폰 {sale.coupon.code}번 · {sale.coupon.benefitLabel}
              {sale.coupon.cancelledAt && " (제공 취소됨)"}
            </span>
            <span>-{formatWon(sale.ledger.couponDiscountAmount)}</span>
          </div>
        )}
        <div className="bill-card__row">
          <span>실제 수납</span>
          <span>{formatWon(sale.ledger.grossChargedAmount)}</span>
        </div>
        {sale.ledger.refundedAmount > 0 && (
          <div className="bill-card__row">
            <span>환불</span>
            <span>-{formatWon(sale.ledger.refundedAmount)}</span>
          </div>
        )}
        <div className="bill-card__row bill-card__row--total">
          <span>부스 매출</span>
          <span>{formatWon(sale.ledger.netChargedAmount)}</span>
        </div>
      </div>

      {sale.payments.length > 0 && (
        <ul className="danger-details">
          {sale.payments.map((payment) => (
            <li key={payment.id}>
              <span className="text-muted">
                {payment.kind === "CHARGE"
                  ? `수납 · ${payment.method}`
                  : payment.kind === "DISCOUNT"
                    ? "쿠폰 할인"
                    : "환불/취소"}{" "}
                · {time(payment.createdAt)} · {payment.createdBy.displayName}
              </span>
              <strong>
                {payment.kind === "CHARGE" ? "" : "-"}
                {formatWon(payment.amount)}
                {payment.changeAmount !== null && payment.changeAmount > 0 && ` (거스름 ${formatWon(payment.changeAmount)})`}
              </strong>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 결제 직후 확인 화면. 손님에게 불러 줄 **주문번호**를 가장 크게 보여준다 —
 * 조리 상품이 있으면 이 번호로 수령을 확인한다(요구사항.md §5.4).
 */
export default function CounterSaleReceipt({ sale, onNewSale }: { sale: CounterSaleDetail; onNewSale: () => void }) {
  const free = sale.ledger.netChargedAmount === 0 && sale.ledger.couponDiscountAmount > 0;
  return (
    <div className="join-code-card">
      <div className="table-hero__number">{free ? "무료 제공 완료" : "결제 완료"}</div>
      <div className="join-code-value">#{String(sale.saleNo).padStart(3, "0")}</div>
      <div className="text-muted">
        손님에게 이 주문번호를 안내해 주세요.
        {sale.pickupPending && " 조리가 끝나면 이 번호로 불러 드립니다."}
      </div>

      <div style={{ textAlign: "left", marginTop: 16 }}>
        <CounterSaleBody sale={sale} />
      </div>

      <button className="btn-primary" onClick={onNewSale}>
        새 거래 시작
      </button>
    </div>
  );
}
