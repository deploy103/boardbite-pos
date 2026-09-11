import type { ReactNode } from "react";

interface BottomSheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

// 가벼운 선택은 non-modal 리스트로도 충분하지만, 옵션 선택/장바구니 확인은 되돌리기 부담이 있는
// 확정 액션이므로 modal 바텀시트 + 명시적 닫기 버튼을 쓴다 (docs/RESEARCH.md Agent C, KRDS 가이드).
export default function BottomSheet({ title, onClose, children, footer }: BottomSheetProps) {
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <h2 className="sheet-title">{title}</h2>
          <button type="button" className="sheet-close" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}
