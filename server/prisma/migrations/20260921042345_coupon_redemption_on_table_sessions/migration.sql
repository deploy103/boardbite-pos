-- 쿠폰을 테이블 후불 정산에서도 쓸 수 있게 한다.
--
-- 기존 행은 전부 현장 거래(counterSaleId NOT NULL)이므로 그대로 복사되고 CHECK 제약도 통과한다.
-- counterSaleId를 nullable로 완화하면서 "사용처는 현장 거래 또는 테이블 세션 중 정확히 하나"를
-- DB가 직접 강제하도록 CHECK를 추가한다 — Order/Payment의 소유자 규칙과 같은 모양이다.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CouponRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "couponId" TEXT NOT NULL,
    "counterSaleId" TEXT,
    "tableSessionId" TEXT,
    "originalAmount" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL,
    "targetOrderItemId" TEXT,
    "targetMenuItemId" TEXT,
    "benefitSnapshot" TEXT NOT NULL,
    "redeemedById" TEXT NOT NULL,
    "redeemedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" DATETIME,
    CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_counterSaleId_fkey" FOREIGN KEY ("counterSaleId") REFERENCES "CounterSale" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "StaffUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- 사용처는 현장 거래 또는 테이블 세션 중 정확히 하나. 애플리케이션 버그나 직접 INSERT로도
    -- 둘 다 채워지거나 둘 다 비는 행이 생기지 않게 DB가 막는다(요구사항.md §8).
    CONSTRAINT "CouponRedemption_owner_exactly_one" CHECK (
        ("counterSaleId" IS NOT NULL AND "tableSessionId" IS NULL)
     OR ("counterSaleId" IS NULL AND "tableSessionId" IS NOT NULL)
    )
);
INSERT INTO "new_CouponRedemption" ("benefitSnapshot", "cancelledAt", "counterSaleId", "couponId", "discountAmount", "id", "originalAmount", "redeemedAt", "redeemedById", "targetMenuItemId", "targetOrderItemId") SELECT "benefitSnapshot", "cancelledAt", "counterSaleId", "couponId", "discountAmount", "id", "originalAmount", "redeemedAt", "redeemedById", "targetMenuItemId", "targetOrderItemId" FROM "CouponRedemption";
DROP TABLE "CouponRedemption";
ALTER TABLE "new_CouponRedemption" RENAME TO "CouponRedemption";
CREATE UNIQUE INDEX "CouponRedemption_couponId_key" ON "CouponRedemption"("couponId");
CREATE INDEX "CouponRedemption_counterSaleId_idx" ON "CouponRedemption"("counterSaleId");
CREATE INDEX "CouponRedemption_tableSessionId_idx" ON "CouponRedemption"("tableSessionId");
CREATE INDEX "CouponRedemption_redeemedAt_idx" ON "CouponRedemption"("redeemedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
