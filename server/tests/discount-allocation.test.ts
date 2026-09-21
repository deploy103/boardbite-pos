import { describe, expect, it } from "vitest";
import { allocateProportional } from "../src/services/discountAllocation.js";

/**
 * 할인 배분 알고리즘(요구사항.md §12.3).
 * 정수 원 단위, 안정적인 행 순서, 합계가 항상 원장과 정확히 일치해야 한다.
 */
describe("allocateProportional", () => {
  it("요구사항 §12.3의 333/667 + 100원 예시와 정확히 일치한다", () => {
    const result = allocateProportional(100, [
      { key: "a", amount: 333 },
      { key: "b", amount: 667 },
    ]);
    expect(result).toEqual([
      { key: "a", amount: 34 },
      { key: "b", amount: 66 },
    ]);
    expect(result.reduce((s, r) => s + r.amount, 0)).toBe(100);
  });

  it("나머지가 생겨도 배분 합계는 항상 총 할인액과 같다", () => {
    for (const total of [1, 7, 99, 1000, 2999]) {
      const lines = [
        { key: "a", amount: 3000 },
        { key: "b", amount: 500 },
        { key: "c", amount: 1 },
      ];
      const result = allocateProportional(total, lines);
      expect(result.reduce((s, r) => s + r.amount, 0)).toBe(total);
      // 어떤 행도 자기 금액보다 많이 할인되지 않는다.
      for (const [i, row] of result.entries()) expect(row.amount).toBeLessThanOrEqual(lines[i].amount);
    }
  });

  it("같은 입력이면 항상 같은 결과다(재조회/CSV에서 배분이 달라지지 않는다)", () => {
    const lines = [
      { key: "a", amount: 1234 },
      { key: "b", amount: 4321 },
      { key: "c", amount: 777 },
    ];
    const first = allocateProportional(1000, lines);
    for (let i = 0; i < 5; i++) expect(allocateProportional(1000, lines)).toEqual(first);
  });

  it("0원 배분은 모든 행을 0으로 만들고 0원 합계에서 나눗셈하지 않는다", () => {
    expect(allocateProportional(0, [{ key: "a", amount: 0 }])).toEqual([{ key: "a", amount: 0 }]);
    expect(() => allocateProportional(100, [{ key: "a", amount: 0 }])).toThrow();
  });

  it("할인액이 할인 전 금액보다 클 수 없다", () => {
    expect(() => allocateProportional(5000, [{ key: "a", amount: 1000 }])).toThrow();
  });
});
