import type { PaymentMethod } from "./types.js";

/** 결제수단 선택 버튼 그룹. 현금(isCash)이면 결제 실행측에서 "받은 금액" UI를 추가로 보여줘야 한다. */
export default function PaymentMethodPicker({
  methods,
  selectedCode,
  onSelect,
}: {
  methods: PaymentMethod[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
}) {
  if (methods.length === 0) {
    return <p className="text-muted">사용할 수 있는 결제수단이 없어요.</p>;
  }

  return (
    <div className="checkout-method-picker" role="radiogroup" aria-label="결제수단 선택">
      {methods.map((m) => (
        <button
          key={m.id}
          type="button"
          className="checkout-method-btn"
          aria-current={selectedCode === m.code}
          onClick={() => onSelect(m.code)}
        >
          {m.name}
        </button>
      ))}
    </div>
  );
}
