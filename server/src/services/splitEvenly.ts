/**
 * N명 더치페이 균등분할. KRW는 소수점이 없으므로 나머지(원 단위)를
 * 최대 나머지법(Largest Remainder Method)으로 배분한다.
 * docs/RESEARCH.md Agent E 근거 — 합계는 항상 원래 금액과 정확히 일치한다.
 */
export function splitEvenly(totalAmount: number, numPeople: number): number[] {
  if (!Number.isInteger(totalAmount) || totalAmount < 0) {
    throw new RangeError("totalAmount는 0 이상의 정수여야 합니다.");
  }
  if (!Number.isInteger(numPeople) || numPeople < 1) {
    throw new RangeError("numPeople은 1 이상의 정수여야 합니다.");
  }

  const base = Math.floor(totalAmount / numPeople);
  const remainder = totalAmount - base * numPeople; // 0 <= remainder < numPeople

  const shares = new Array<number>(numPeople).fill(base);
  for (let i = 0; i < remainder; i++) {
    shares[i] += 1;
  }

  return shares;
}
