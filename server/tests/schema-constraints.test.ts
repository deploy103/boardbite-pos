import { describe, expect, it } from "vitest";
import { prisma } from "../src/prisma.js";

/**
 * 스키마 제약 회귀 가드.
 *
 * 손으로 넣은 CHECK 제약은 **Prisma가 생성하는 테이블 재작성 migration에서 조용히 사라진다**
 * (Prisma는 schema.prisma에 없는 제약을 알지 못하므로 새 테이블에 다시 붙여주지 않는다).
 * 실제로 이번 작업에서 Order의 소유자 CHECK가 그렇게 빠질 뻔했다.
 *
 * 이 테스트는 migration을 모두 적용한 DB의 실제 DDL을 읽어 제약이 살아 있는지 확인한다.
 * 앞으로 누군가 재작성 migration을 만들면서 제약을 빠뜨리면 여기서 바로 실패한다 —
 * 문서에 "확인하세요"라고 적어두는 대신 CI가 대신 확인해 준다.
 */
describe("스키마 제약이 migration 이후에도 살아 있다", () => {
  async function ddlOf(table: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ sql: string }[]>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      table,
    );
    expect(rows.length, `${table} 테이블이 없습니다`).toBe(1);
    return rows[0].sql;
  }

  it.each([
    ["Order", "Order_owner_exactly_one"],
    ["Payment", "Payment_owner_exactly_one"],
    ["CouponRedemption", "CouponRedemption_owner_exactly_one"],
  ])("%s 테이블에 %s CHECK 제약이 남아 있다", async (table, constraint) => {
    const sql = await ddlOf(table);
    expect(sql, `${table}의 ${constraint} CHECK가 사라졌습니다 — 재작성 migration에서 빠뜨렸는지 확인하세요`).toContain(
      constraint,
    );
  });

  it("주요 UNIQUE 제약이 남아 있다", async () => {
    const indexes = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '%UNIQUE%'`,
    );
    const names = indexes.map((i) => i.name);
    for (const expected of [
      "Order_idempotencyKey_key",
      "Payment_idempotencyKey_key",
      "Coupon_code_key",
      "CouponRedemption_couponId_key",
      "CounterSale_saleNo_key",
      "CounterSale_idempotencyKey_key",
      "CouponBatch_idempotencyKey_key",
    ]) {
      expect(names, `${expected} UNIQUE 인덱스가 사라졌습니다`).toContain(expected);
    }
  });

  it("CHECK 제약이 실제로 잘못된 INSERT를 막는다", async () => {
    // DDL에 문자열만 남고 실제로는 동작하지 않는 경우까지 걸러낸다.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Order" ("id","status","idempotencyKey","createdAt") VALUES ('guard-order','NEW','guard-order',CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow();
  });
});
