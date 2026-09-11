import { describe, it, expect } from "vitest";
import { splitEvenly } from "../src/services/splitEvenly.js";

describe("splitEvenly (더치페이 최대 나머지법)", () => {
  it("나누어 떨어지는 경우 모두 동일하게 분배한다", () => {
    expect(splitEvenly(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  it("나누어 떨어지지 않으면 나머지를 앞사람부터 1원씩 배분하고 합계는 정확히 일치한다", () => {
    const shares = splitEvenly(30000, 7);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(30000);
    expect(shares.filter((s) => s === 4286)).toHaveLength(5);
    expect(shares.filter((s) => s === 4285)).toHaveLength(2);
  });

  it("금액이 0이어도 인원수만큼 0원씩 배분한다", () => {
    expect(splitEvenly(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("1명이면 전액을 그대로 반환한다", () => {
    expect(splitEvenly(12345, 1)).toEqual([12345]);
  });

  it("정수가 아닌 총액은 거부한다", () => {
    expect(() => splitEvenly(100.5, 3)).toThrow();
  });

  it("0명 이하는 거부한다", () => {
    expect(() => splitEvenly(1000, 0)).toThrow();
  });
});
