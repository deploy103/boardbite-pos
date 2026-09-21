-- BoardBite POS — FRONT 현장 결제 / 쿠폰 / 메뉴 수명주기 migration
--
-- 데이터 보존 원칙(요구사항.md §12.4, 요구사항2.md §11):
--   * 기존 행은 하나도 삭제하지 않는다. 아래 RedefineTables 블록은 SQLite에서
--     NOT NULL → NULL 완화와 CHECK 제약 추가를 하기 위한 표준 테이블 재작성이며,
--     모든 기존 컬럼을 그대로 복사한다(신규 컬럼은 DEFAULT로 채워진다).
--   * MenuItem.channel 은 DEFAULT 'BOTH' 로 채워져 기존 메뉴의 테이블 판매 가능성이 유지된다.
--   * OrderItem.servingMode 는 DEFAULT 'KITCHEN' 으로 채워진다(지금까지의 모든 주문은 주방을 거쳤다).
--   * OrderItemOption.groupNameSnapshot 은 NULL로 남긴다 — 과거 주문의 "그때 그룹명"을
--     현재 이름으로 지어내지 않는다.
--   * 재작성 후 행 수/합계/foreign_key_check 검증 방법은 README "데이터 보존 업데이트" 절 참고.

-- AlterTable
ALTER TABLE "MenuCategory" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "OptionChoice" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "OrderItemOption" ADD COLUMN "groupNameSnapshot" TEXT;

-- CreateTable
CREATE TABLE "CounterSale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledById" TEXT,
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    CONSTRAINT "CounterSale_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CounterSale_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "StaffUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CouponBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memo" TEXT,
    "amount" INTEGER,
    "expiresAt" DATETIME,
    "issuedCount" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CouponBatchTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    CONSTRAINT "CouponBatchTarget_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CouponBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CouponBatchTarget_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "usedAt" DATETIME,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Coupon_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CouponBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "couponId" TEXT NOT NULL,
    "counterSaleId" TEXT NOT NULL,
    "originalAmount" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL,
    "targetOrderItemId" TEXT,
    "targetMenuItemId" TEXT,
    "benefitSnapshot" TEXT NOT NULL,
    "redeemedById" TEXT NOT NULL,
    "redeemedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" DATETIME,
    CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_counterSaleId_fkey" FOREIGN KEY ("counterSaleId") REFERENCES "CounterSale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CouponRedemption_redeemedById_fkey" FOREIGN KEY ("redeemedById") REFERENCES "StaffUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSoldOut" BOOLEAN NOT NULL DEFAULT false,
    "needsCooking" BOOLEAN NOT NULL DEFAULT true,
    "showInKitchen" BOOLEAN NOT NULL DEFAULT true,
    "channel" TEXT NOT NULL DEFAULT 'BOTH',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_MenuItem" ("categoryId", "createdAt", "description", "id", "imageUrl", "isActive", "isSoldOut", "name", "needsCooking", "price", "showInKitchen", "sortOrder") SELECT "categoryId", "createdAt", "description", "id", "imageUrl", "isActive", "isSoldOut", "name", "needsCooking", "price", "showInKitchen", "sortOrder" FROM "MenuItem";
DROP TABLE "MenuItem";
ALTER TABLE "new_MenuItem" RENAME TO "MenuItem";
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");
CREATE TABLE "new_OptionGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "multiSelect" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" DATETIME,
    CONSTRAINT "OptionGroup_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_OptionGroup" ("id", "menuItemId", "multiSelect", "name", "required", "sortOrder") SELECT "id", "menuItemId", "multiSelect", "name", "required", "sortOrder" FROM "OptionGroup";
DROP TABLE "OptionGroup";
ALTER TABLE "new_OptionGroup" RENAME TO "OptionGroup";
CREATE INDEX "OptionGroup_menuItemId_idx" ON "OptionGroup"("menuItemId");
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableSessionId" TEXT,
    "counterSaleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "rejectReason" TEXT,
    "cancelReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "preparingAt" DATETIME,
    "readyAt" DATETIME,
    "servedAt" DATETIME,
    "cancelledAt" DATETIME,
    CONSTRAINT "Order_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_counterSaleId_fkey" FOREIGN KEY ("counterSaleId") REFERENCES "CounterSale" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    -- 요구사항.md §8/§12.1: 주문의 소유자는 테이블 세션 또는 현장 거래 중 "정확히 하나"다.
    -- 애플리케이션 버그나 직접 INSERT로도 둘 다 채워지거나 둘 다 비는 행이 생기지 않게 DB가 막는다.
    CONSTRAINT "Order_owner_exactly_one" CHECK (
        ("tableSessionId" IS NOT NULL AND "counterSaleId" IS NULL)
     OR ("tableSessionId" IS NULL AND "counterSaleId" IS NOT NULL)
    )
);
INSERT INTO "new_Order" ("acceptedAt", "cancelReason", "cancelledAt", "createdAt", "id", "idempotencyKey", "note", "preparingAt", "readyAt", "rejectReason", "servedAt", "status", "tableSessionId") SELECT "acceptedAt", "cancelReason", "cancelledAt", "createdAt", "id", "idempotencyKey", "note", "preparingAt", "readyAt", "rejectReason", "servedAt", "status", "tableSessionId" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");
CREATE INDEX "Order_tableSessionId_status_idx" ON "Order"("tableSessionId", "status");
CREATE INDEX "Order_counterSaleId_idx" ON "Order"("counterSaleId");
CREATE TABLE "new_OrderItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "servingMode" TEXT NOT NULL DEFAULT 'KITCHEN',
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_OrderItem" ("id", "menuItemId", "nameSnapshot", "orderId", "quantity", "unitPrice") SELECT "id", "menuItemId", "nameSnapshot", "orderId", "quantity", "unitPrice" FROM "OrderItem";
DROP TABLE "OrderItem";
ALTER TABLE "new_OrderItem" RENAME TO "OrderItem";
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE TABLE "new_Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableSessionId" TEXT,
    "counterSaleId" TEXT,
    "kind" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "tenderedAmount" INTEGER,
    "changeAmount" INTEGER,
    "payerLabel" TEXT,
    "reversedPaymentId" TEXT,
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Payment_counterSaleId_fkey" FOREIGN KEY ("counterSaleId") REFERENCES "CounterSale" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Payment_reversedPaymentId_fkey" FOREIGN KEY ("reversedPaymentId") REFERENCES "Payment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Payment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Order와 동일한 소유자 제약. 결제 행이 어느 원장에도 속하지 않거나 두 원장에 동시에
    -- 속하면 매출 집계가 이중 계상되므로 DB 레벨에서 차단한다.
    CONSTRAINT "Payment_owner_exactly_one" CHECK (
        ("tableSessionId" IS NOT NULL AND "counterSaleId" IS NULL)
     OR ("tableSessionId" IS NULL AND "counterSaleId" IS NOT NULL)
    )
);
INSERT INTO "new_Payment" ("amount", "changeAmount", "createdAt", "createdById", "id", "idempotencyKey", "kind", "method", "payerLabel", "reason", "reversedPaymentId", "tableSessionId", "tenderedAmount") SELECT "amount", "changeAmount", "createdAt", "createdById", "id", "idempotencyKey", "kind", "method", "payerLabel", "reason", "reversedPaymentId", "tableSessionId", "tenderedAmount" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
CREATE INDEX "Payment_tableSessionId_idx" ON "Payment"("tableSessionId");
CREATE INDEX "Payment_counterSaleId_idx" ON "Payment"("counterSaleId");
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CounterSale_saleNo_key" ON "CounterSale"("saleNo");

-- CreateIndex
CREATE UNIQUE INDEX "CounterSale_idempotencyKey_key" ON "CounterSale"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CounterSale_createdAt_idx" ON "CounterSale"("createdAt");

-- CreateIndex
CREATE INDEX "CounterSale_status_idx" ON "CounterSale"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CouponBatch_idempotencyKey_key" ON "CouponBatch"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CouponBatch_createdAt_idx" ON "CouponBatch"("createdAt");

-- CreateIndex
CREATE INDEX "CouponBatchTarget_menuItemId_idx" ON "CouponBatchTarget"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponBatchTarget_batchId_menuItemId_key" ON "CouponBatchTarget"("batchId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_status_idx" ON "Coupon"("status");

-- CreateIndex
CREATE INDEX "Coupon_batchId_idx" ON "Coupon"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_couponId_key" ON "CouponRedemption"("couponId");

-- CreateIndex
CREATE INDEX "CouponRedemption_counterSaleId_idx" ON "CouponRedemption"("counterSaleId");

-- CreateIndex
CREATE INDEX "CouponRedemption_redeemedAt_idx" ON "CouponRedemption"("redeemedAt");
