/**
 * 옵션 그룹의 선택 개수 규칙(요구사항 5절 — 옵션 최소/최대 선택 개수).
 *
 * DB에는 minSelect/maxSelect **한 쌍만** 둔다. 예전처럼 required/multiSelect 두 불리언을 따로
 * 두면 "필수인데 최대 0개" 같은 모순을 막을 곳이 없고, "최소 2개 최대 3개" 같은 범위도 표현할 수 없다.
 * 화면이 쓰는 required/multiSelect는 여기서 파생해 내려보낸다 — 값이 두 곳에 복사되지 않는다.
 */

export interface SelectRange {
  minSelect: number;
  /** null이면 제한 없음. */
  maxSelect: number | null;
}

/** 하나 이상 반드시 골라야 하는 그룹인가. */
export function isRequired(group: SelectRange): boolean {
  return group.minSelect > 0;
}

/** 두 개 이상 고를 수 있는 그룹인가(체크박스로 그릴지 라디오로 그릴지의 기준). */
export function isMultiSelect(group: SelectRange): boolean {
  return group.maxSelect === null || group.maxSelect > 1;
}

/** 화면에 보여줄 규칙 문구. "필수", "1~2개", "최대 3개"처럼 사람이 읽는 형태다. */
export function describeSelectRange(group: SelectRange): string {
  const { minSelect, maxSelect } = group;
  if (minSelect === 0 && maxSelect === null) return "여러 개 선택 가능";
  if (minSelect === 0 && maxSelect === 1) return "선택";
  if (minSelect === 1 && maxSelect === 1) return "필수";
  if (maxSelect === null) return `${minSelect}개 이상`;
  if (minSelect === 0) return `최대 ${maxSelect}개`;
  if (minSelect === maxSelect) return `${minSelect}개 선택`;
  return `${minSelect}~${maxSelect}개`;
}

/** API 응답에 파생 값을 함께 실어 준다. 클라이언트가 규칙을 다시 계산하지 않게 한다. */
export function decorateSelectRange<T extends SelectRange>(group: T) {
  return {
    ...group,
    required: isRequired(group),
    multiSelect: isMultiSelect(group),
    selectRangeLabel: describeSelectRange(group),
  };
}

export class SelectRangeError extends Error {}

/**
 * 관리자가 저장하려는 범위가 말이 되는지 검사한다.
 * 모순된 설정(최대 0개, 최소 > 최대, 선택지 수보다 큰 최소)을 저장 시점에 막아,
 * 손님이 주문할 수 없는 메뉴가 조용히 만들어지는 것을 방지한다.
 */
export function assertValidSelectRange(range: SelectRange, activeChoiceCount?: number): void {
  const { minSelect, maxSelect } = range;
  if (!Number.isInteger(minSelect) || minSelect < 0) {
    throw new SelectRangeError("최소 선택 개수는 0 이상의 정수여야 해요.");
  }
  if (maxSelect !== null) {
    if (!Number.isInteger(maxSelect) || maxSelect < 1) {
      throw new SelectRangeError("최대 선택 개수는 1 이상이어야 해요. 제한이 없으면 비워 두세요.");
    }
    if (minSelect > maxSelect) {
      throw new SelectRangeError(`최소 ${minSelect}개인데 최대가 ${maxSelect}개일 수는 없어요.`);
    }
  }
  if (activeChoiceCount !== undefined && minSelect > activeChoiceCount) {
    throw new SelectRangeError(
      `고를 수 있는 선택지가 ${activeChoiceCount}개뿐이라 최소 ${minSelect}개를 요구할 수 없어요.`,
    );
  }
}

/**
 * 주문에서 고른 개수가 규칙에 맞는지 검사한다. 맞지 않으면 사람이 읽을 수 있는 이유를 돌려준다.
 * (검사만 하고 던지지 않는다 — 호출부가 품절 여부 등 문맥을 더해 메시지를 완성한다.)
 */
export function checkSelectedCount(group: SelectRange & { name: string }, count: number): string | null {
  if (group.maxSelect !== null && count > group.maxSelect) {
    return group.maxSelect === 1
      ? `'${group.name}' 옵션은 하나만 선택할 수 있습니다.`
      : `'${group.name}' 옵션은 최대 ${group.maxSelect}개까지 선택할 수 있습니다.`;
  }
  if (count < group.minSelect) {
    return group.minSelect === 1
      ? `'${group.name}' 옵션을 선택해 주세요.`
      : `'${group.name}' 옵션을 ${group.minSelect}개 이상 선택해 주세요.`;
  }
  return null;
}
