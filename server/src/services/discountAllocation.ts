/**
 * 할인 배분(요구사항.md §12.3).
 *
 * 금액권처럼 "거래 전체에 걸리는 할인"은 결국 각 주문 항목에 얼마씩 걸렸는지로 저장해야
 * 메뉴별 통계·CSV·환불이 원장과 정확히 일치한다. 부동소수점을 쓰지 않고 정수 원 단위로만
 * 계산하며, 같은 입력에는 항상 같은 결과가 나온다(재조회·CSV 재생성에서 배분이 달라지지 않는다).
 *
 *   d_i = floor(D * g_i / G)
 *   남은 D - sum(d_i) 원을 "아직 할인 여력이 있는 행"에 배열 순서대로 1원씩 나눠 준다.
 *
 * 예) 행 금액 333/667원에 100원 금액권 → 33/66원 배분 후 남은 1원을 첫 행에 → 34/66, 합계 100원.
 */
export interface AllocatableLine {
  /** 안정적인 행 식별자(주문 항목 id 등). */
  key: string;
  /** 이 행의 할인 전 금액. */
  amount: number;
}

export interface AllocationResult {
  key: string;
  amount: number;
}

export function allocateProportional(total: number, lines: AllocatableLine[]): AllocationResult[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("배분할 금액은 0 이상의 정수여야 합니다.");
  }
  const grand = lines.reduce((sum, line) => sum + line.amount, 0);
  if (total === 0 || lines.length === 0) {
    return lines.map((line) => ({ key: line.key, amount: 0 }));
  }
  if (grand <= 0) {
    // 0원 합계에서 나눗셈을 실행하지 않는다(요구사항.md §12.3).
    throw new Error("할인 전 금액이 0원인 거래에는 금액을 배분할 수 없습니다.");
  }
  if (total > grand) {
    throw new Error("할인액이 할인 전 금액보다 클 수 없습니다.");
  }

  const result = lines.map((line) => ({
    key: line.key,
    amount: Math.floor((total * line.amount) / grand),
  }));

  let remainder = total - result.reduce((sum, r) => sum + r.amount, 0);
  // 배열 순서 = 안정적인 행 순서. 이미 자기 행 금액만큼 할인된 행은 건너뛴다.
  for (let i = 0; remainder > 0; i = (i + 1) % lines.length) {
    if (result[i].amount < lines[i].amount) {
      result[i].amount += 1;
      remainder -= 1;
    }
    // 한 바퀴를 다 돌았는데도 더 줄 곳이 없다면(이론상 total<=grand이므로 발생하지 않음) 무한루프를 막는다.
    if (i === lines.length - 1 && result.every((r, idx) => r.amount >= lines[idx].amount)) break;
  }

  return result;
}
