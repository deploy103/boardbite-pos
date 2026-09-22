import { useMemo, useState } from "react";
import BottomSheet from "./BottomSheet.js";
import type { MenuItem, OptionGroup } from "./types.js";
import { allChoicesOf } from "./types.js";

interface OptionSheetProps {
  item: MenuItem;
  /** 장바구니 행을 다시 열어 고칠 때 넘긴다(요구사항.md §3.2 — 장바구니에서 옵션/수량 변경). */
  initialOptionChoiceIds?: string[];
  initialQuantity?: number;
  confirmLabelPrefix?: string;
  onClose: () => void;
  onConfirm: (selection: { optionChoiceIds: string[]; quantity: number }) => void;
}

/**
 * 옵션 그룹이 있는 메뉴는 "담기"를 누르면 이 바텀시트에서 옵션과 수량을 정하고 확정한다.
 * 손님 화면과 FRONT 현장 결제가 같은 컴포넌트를 쓰므로 옵션 규칙이 두 화면에서 어긋나지 않는다.
 *
 * - 필수 그룹은 반드시 하나 선택해야 담을 수 있다.
 * - 선택(필수 아님) 단일 그룹은 '선택 안 함'으로 되돌릴 수 있다 — 한 번 고르면 못 빼는 문제를 막는다.
 * - 무료 옵션도 "+0원"이라고 분명히 보여준다. 값이 없는 것과 0원인 것은 다르다.
 */
export default function OptionSheet({
  item,
  initialOptionChoiceIds,
  initialQuantity,
  confirmLabelPrefix = "담기",
  onClose,
  onConfirm,
}: OptionSheetProps) {
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    if (!initialOptionChoiceIds?.length) return initial;
    for (const group of item.optionGroups) {
      // 장바구니를 다시 열었을 때 그 사이 품절된 옵션은 선택을 풀어 준다.
      const picked = group.choices.filter((c) => initialOptionChoiceIds.includes(c.id) && !c.isSoldOut).map((c) => c.id);
      if (picked.length > 0) initial[group.id] = picked;
    }
    return initial;
  });
  const [quantity, setQuantity] = useState(initialQuantity ?? 1);

  function toggleChoice(group: OptionGroup, choiceId: string) {
    setSelectedByGroup((prev) => {
      const current = prev[group.id] ?? [];
      if (group.multiSelect) {
        if (current.includes(choiceId)) return { ...prev, [group.id]: current.filter((id) => id !== choiceId) };
        // 최대 개수를 넘기면 더 고를 수 없다(서버도 같은 규칙으로 막는다).
        if (group.maxSelect !== null && current.length >= group.maxSelect) return prev;
        return { ...prev, [group.id]: [...current, choiceId] };
      }
      // 선택 그룹의 단일 선택은 같은 항목을 다시 누르면 해제된다.
      if (!group.required && current.includes(choiceId)) {
        return { ...prev, [group.id]: [] };
      }
      return { ...prev, [group.id]: [choiceId] };
    });
  }

  function clearGroup(group: OptionGroup) {
    setSelectedByGroup((prev) => ({ ...prev, [group.id]: [] }));
  }

  const selectedIds = useMemo(() => Object.values(selectedByGroup).flat(), [selectedByGroup]);

  /**
   * 필수인데 고를 수 있는 선택지가 하나도 없는 그룹 = 지금은 팔 수 없는 메뉴다(서버도 주문을 거부한다).
   * 선택지가 있어도 **전부 품절**이면 마찬가지다.
   */
  const selectableOf = (group: OptionGroup) => group.choices.filter((choice) => !choice.isSoldOut);
  // 최소 개수를 채울 만큼 고를 수 있는 선택지가 없으면 지금은 팔 수 없는 메뉴다.
  const unsellableGroups = item.optionGroups.filter(
    (group) => group.minSelect > 0 && selectableOf(group).length < group.minSelect,
  );
  const missingRequiredGroup = item.optionGroups.find(
    (group) =>
      group.minSelect > 0 &&
      selectableOf(group).length >= group.minSelect &&
      (selectedByGroup[group.id]?.length ?? 0) < group.minSelect,
  );
  const canConfirm = unsellableGroups.length === 0 && !missingRequiredGroup;

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
          {unsellableGroups.length > 0
            ? "지금은 주문할 수 없어요"
            : canConfirm
              ? `${lineTotal.toLocaleString()}원 ${confirmLabelPrefix}`
              : missingRequiredGroup!.minSelect > 1
              ? `'${missingRequiredGroup!.name}' 옵션을 ${missingRequiredGroup!.minSelect}개 이상 선택해 주세요`
              : `'${missingRequiredGroup!.name}' 옵션을 선택해 주세요`}
        </button>
      }
    >
      {item.description && <p className="sheet-desc">{item.description}</p>}

      {unsellableGroups.length > 0 && (
        <p className="error-text">
          '{unsellableGroups.map((g) => g.name).join(", ")}' 옵션을 지금 고를 수 없어요(품절이거나 준비되지 않았어요).
          직원에게 알려 주세요.
        </p>
      )}

      {item.optionGroups.map((group) => {
        const selected = selectedByGroup[group.id] ?? [];
        const showClear = !group.required && !group.multiSelect && selected.length > 0;
        return (
          <div className="option-group" key={group.id}>
            <div className="option-group__title">
              <span>{group.name}</span>
              {/* 규칙 문구는 서버가 만들어 내려준다 — 화면마다 다르게 표현되지 않는다. */}
              <span className={`badge ${group.required ? "badge--warn" : ""}`}>{group.selectRangeLabel}</span>
              {group.maxSelect !== null && group.maxSelect > 1 && (
                <span className="text-muted" style={{ fontSize: "0.8rem" }}>
                  {selected.length}/{group.maxSelect}
                </span>
              )}
              {showClear && (
                <button type="button" className="option-group__clear" onClick={() => clearGroup(group)}>
                  선택 안 함
                </button>
              )}
            </div>
            {group.choices.length === 0 && <p className="text-muted">선택할 수 있는 항목이 없어요.</p>}
            {group.choices.map((choice) => {
              const checked = selected.includes(choice.id);
              // 품절 옵션은 감추지 않고 회색으로 남겨 둔다 — "원래 있는데 지금 떨어졌다"가 보여야
              // 손님이 메뉴 구성을 오해하지 않는다.
              const soldOut = Boolean(choice.isSoldOut);
              // 최대 개수를 채웠으면 아직 고르지 않은 항목은 누를 수 없게 한다.
              const capReached =
                group.maxSelect !== null && group.maxSelect > 1 && !checked && selected.length >= group.maxSelect;
              return (
                <label
                  className={`option-choice ${soldOut ? "option-choice--sold-out" : ""} ${capReached ? "option-choice--capped" : ""}`}
                  key={choice.id}
                  aria-disabled={soldOut || capReached}
                >
                  <input
                    type={group.multiSelect ? "checkbox" : "radio"}
                    name={group.id}
                    checked={checked}
                    disabled={soldOut || capReached}
                    onChange={() => toggleChoice(group, choice.id)}
                    onClick={() => {
                      // radio는 같은 값을 다시 눌러도 change가 안 나므로 클릭에서 해제를 처리한다.
                      if (!group.multiSelect && !group.required && checked) clearGroup(group);
                    }}
                  />
                  <span className="option-choice__name">{choice.name}</span>
                  {soldOut && <span className="badge badge--danger">품절</span>}
                  {/* 무료 옵션도 값을 숨기지 않고 +0원으로 명시한다(요구사항.md §3.2). */}
                  <span className={`option-choice__price ${choice.extraPrice === 0 ? "option-choice__price--free" : ""}`}>
                    +{choice.extraPrice.toLocaleString()}원
                  </span>
                </label>
              );
            })}
          </div>
        );
      })}

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
