import { useMemo, useState } from "react";
import BottomSheet from "./BottomSheet.js";
import type { MenuItem, OptionGroup } from "./types.js";
import { allChoicesOf } from "./types.js";

interface OptionSheetProps {
  item: MenuItem;
  onClose: () => void;
  onConfirm: (selection: { optionChoiceIds: string[]; quantity: number }) => void;
}

// 옵션 그룹이 있는 메뉴는 "담기"를 누르면 이 바텀시트에서 옵션과 수량을 정하고 확정한다.
// required 그룹은 반드시 하나 선택해야 담을 수 있다.
export default function OptionSheet({ item, onClose, onConfirm }: OptionSheetProps) {
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);

  function toggleChoice(group: OptionGroup, choiceId: string) {
    setSelectedByGroup((prev) => {
      const current = prev[group.id] ?? [];
      if (group.multiSelect) {
        const next = current.includes(choiceId)
          ? current.filter((id) => id !== choiceId)
          : [...current, choiceId];
        return { ...prev, [group.id]: next };
      }
      return { ...prev, [group.id]: [choiceId] };
    });
  }

  const selectedIds = useMemo(() => Object.values(selectedByGroup).flat(), [selectedByGroup]);

  const missingRequiredGroup = item.optionGroups.find(
    (group) => group.required && (selectedByGroup[group.id]?.length ?? 0) === 0,
  );
  const canConfirm = !missingRequiredGroup;

  const optionsTotal = useMemo(() => {
    const choices = allChoicesOf(item);
    return selectedIds.reduce((sum, id) => sum + (choices.find((c) => c.id === id)?.extraPrice ?? 0), 0);
  }, [item, selectedIds]);

  const lineTotal = (item.price + optionsTotal) * quantity;

  return (
    <BottomSheet
      title={item.name}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn-primary"
          disabled={!canConfirm}
          onClick={() => onConfirm({ optionChoiceIds: selectedIds, quantity })}
        >
          {canConfirm ? `${lineTotal.toLocaleString()}원 담기` : "옵션을 선택해 주세요"}
        </button>
      }
    >
      {item.description && <p className="sheet-desc">{item.description}</p>}

      {item.optionGroups.map((group) => (
        <div className="option-group" key={group.id}>
          <div className="option-group__title">
            <span>{group.name}</span>
            {group.required && <span className="badge badge--warn">필수</span>}
            {group.multiSelect && <span className="badge">여러 개 선택 가능</span>}
          </div>
          {group.choices.map((choice) => {
            const checked = (selectedByGroup[group.id] ?? []).includes(choice.id);
            return (
              <label className="option-choice" key={choice.id}>
                <input
                  type={group.multiSelect ? "checkbox" : "radio"}
                  name={group.id}
                  checked={checked}
                  onChange={() => toggleChoice(group, choice.id)}
                />
                <span className="option-choice__name">{choice.name}</span>
                {choice.extraPrice > 0 && (
                  <span className="option-choice__price">+{choice.extraPrice.toLocaleString()}원</span>
                )}
              </label>
            );
          })}
        </div>
      ))}

      <div className="qty-row">
        <span className="text-body">수량</span>
        <div className="qty-stepper">
          <button
            type="button"
            className="qty-btn"
            disabled={quantity <= 1}
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            aria-label="수량 줄이기"
          >
            −
          </button>
          <span className="qty-value">{quantity}</span>
          <button
            type="button"
            className="qty-btn"
            disabled={quantity >= 50}
            onClick={() => setQuantity((q) => Math.min(50, q + 1))}
            aria-label="수량 늘리기"
          >
            +
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
