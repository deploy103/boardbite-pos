import BottomSheet from "./BottomSheet.js";
import type { CartLine } from "./types.js";
import { lineOptionNames, lineUnitPrice } from "./types.js";

interface CartSheetProps {
  lines: CartLine[];
  total: number;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onChangeQuantity: (lineId: string, quantity: number) => void;
  onRemove: (lineId: string) => void;
  onSubmit: () => void;
}

// 요구사항 7.3 — 주문 전 최종 확인(메뉴/수량/옵션/예상 합계) + 수량 조절/삭제.
export default function CartSheet({
  lines,
  total,
  submitting,
  error,
  onClose,
  onChangeQuantity,
  onRemove,
  onSubmit,
}: CartSheetProps) {
  return (
    <BottomSheet
      title="주문 확인"
      onClose={onClose}
      footer={
        <>
          {error && <p className="error-text" style={{ marginBottom: 8 }}>{error}</p>}
          <div className="cart-total">
            <span className="cart-total__label">예상 합계</span>
            <span className="cart-total__value">{total.toLocaleString()}원</span>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={submitting || lines.length === 0}
            onClick={onSubmit}
          >
            {submitting ? "주문을 접수하고 있어요..." : "주문하기"}
          </button>
        </>
      }
    >
      {lines.length === 0 && <p className="text-muted">담은 메뉴가 없어요.</p>}

      {lines.map((line) => {
        const unitPrice = lineUnitPrice(line);
        const optionNames = lineOptionNames(line);
        return (
          <div className="cart-line" key={line.id}>
            <div className="cart-line__top">
              <div>
                <div className="cart-line__name">{line.menuItem.name}</div>
                {optionNames.length > 0 && (
                  <div className="cart-line__options">{optionNames.join(" · ")}</div>
                )}
              </div>
              <div className="cart-line__price">{(unitPrice * line.quantity).toLocaleString()}원</div>
            </div>
            <div className="cart-line__bottom">
              <div className="qty-stepper">
                <button
                  type="button"
                  className="qty-btn"
                  disabled={submitting || line.quantity <= 1}
                  onClick={() => onChangeQuantity(line.id, line.quantity - 1)}
                  aria-label="수량 줄이기"
                >
                  −
                </button>
                <span className="qty-value">{line.quantity}</span>
                <button
                  type="button"
                  className="qty-btn"
                  disabled={submitting || line.quantity >= 50}
                  onClick={() => onChangeQuantity(line.id, line.quantity + 1)}
                  aria-label="수량 늘리기"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                className="cart-line__remove"
                disabled={submitting}
                onClick={() => onRemove(line.id)}
              >
                삭제
              </button>
            </div>
          </div>
        );
      })}
    </BottomSheet>
  );
}
