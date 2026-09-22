-- 공용 재고 물품(InventoryItem) 도입 + 주문/항목 취소 정보 확장
--
-- 데이터 보존:
--   * OptionChoice.linkedMenuItemId(직전 버전의 "옵션 → 메뉴" 연결)는 버리지 않고
--     **공용 물품으로 승격**한다. 연결되어 있던 메뉴마다 InventoryItem을 하나 만들고,
--     그 메뉴와 그 메뉴를 가리키던 모든 옵션 선택지를 같은 물품에 연결한다.
--     결과적으로 기존 "계란 품절 → 계란 추가 옵션 품절" 동작이 그대로 유지되면서,
--     이제는 옵션 쪽에서 품절 처리해도 메뉴에 반영되는 양방향이 된다.
--   * 물품의 초기 품절 상태는 연결돼 있던 메뉴의 현재 isSoldOut 값을 그대로 가져온다.
--   * 기존 주문/주문 항목은 취소 정보가 NULL인 채로 복사된다(취소된 적 없음).
--   * Order 재작성 시 소유자 CHECK 제약을 다시 붙인다 — Prisma가 생성한 SQL에는
--     손으로 넣은 CHECK가 빠져 있어 그대로 두면 제약이 조용히 사라진다.

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "isSoldOut" BOOLEAN NOT NULL DEFAULT false,
    "soldOutAt" DATETIME,
    "soldOutById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "InventoryItem_soldOutById_fkey" FOREIGN KEY ("soldOutById") REFERENCES "StaffUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- 기존 "옵션 → 메뉴" 연결을 공용 물품으로 승격한다.
-- id는 'inv_' || 메뉴id 로 결정적으로 만들어 아래 두 복사 구문에서 동일하게 참조한다.
INSERT INTO "InventoryItem" ("id", "name", "isSoldOut", "createdAt")
SELECT DISTINCT 'inv_' || mi."id", mi."name", mi."isSoldOut", CURRENT_TIMESTAMP
  FROM "MenuItem" mi
 WHERE mi."id" IN (SELECT "linkedMenuItemId" FROM "OptionChoice" WHERE "linkedMenuItemId" IS NOT NULL);

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
    "inventoryItemId" TEXT,
    "needsCooking" BOOLEAN NOT NULL DEFAULT true,
    "showInKitchen" BOOLEAN NOT NULL DEFAULT true,
    "channel" TEXT NOT NULL DEFAULT 'BOTH',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MenuItem_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MenuItem" ("categoryId", "channel", "createdAt", "deletedAt", "description", "id", "imageUrl", "isActive", "isSoldOut", "inventoryItemId", "name", "needsCooking", "price", "showInKitchen", "sortOrder")
SELECT "categoryId", "channel", "createdAt", "deletedAt", "description", "id", "imageUrl", "isActive", "isSoldOut",
       (SELECT ii."id" FROM "InventoryItem" ii WHERE ii."id" = 'inv_' || "MenuItem"."id"),
       "name", "needsCooking", "price", "showInKitchen", "sortOrder"
  FROM "MenuItem";
DROP TABLE "MenuItem";
ALTER TABLE "new_MenuItem" RENAME TO "MenuItem";
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");
CREATE INDEX "MenuItem_inventoryItemId_idx" ON "MenuItem"("inventoryItemId");
CREATE TABLE "new_OptionChoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extraPrice" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    "isSoldOut" BOOLEAN NOT NULL DEFAULT false,
    "inventoryItemId" TEXT,
    CONSTRAINT "OptionChoice_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OptionGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OptionChoice_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OptionChoice" ("deletedAt", "extraPrice", "groupId", "id", "isActive", "isSoldOut", "inventoryItemId", "name", "sortOrder")
SELECT "deletedAt", "extraPrice", "groupId", "id", "isActive", 0,
       CASE WHEN "linkedMenuItemId" IS NOT NULL THEN 'inv_' || "linkedMenuItemId" ELSE NULL END,
       "name", "sortOrder"
  FROM "OptionChoice";
DROP TABLE "OptionChoice";
ALTER TABLE "new_OptionChoice" RENAME TO "OptionChoice";
CREATE INDEX "OptionChoice_groupId_idx" ON "OptionChoice"("groupId");
CREATE INDEX "OptionChoice_inventoryItemId_idx" ON "OptionChoice"("inventoryItemId");
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableSessionId" TEXT,
    "counterSaleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "rejectReason" TEXT,
    "cancelReason" TEXT,
    "cancelReasonCode" TEXT,
    "cancelNote" TEXT,
    "cancelledById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "preparingAt" DATETIME,
    "readyAt" DATETIME,
    "servedAt" DATETIME,
    "cancelledAt" DATETIME,
    CONSTRAINT "Order_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_counterSaleId_fkey" FOREIGN KEY ("counterSaleId") REFERENCES "CounterSale" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "StaffUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    -- 소유자는 테이블 세션 또는 현장 거래 중 정확히 하나(요구사항.md §8/§12.1).
    -- Prisma 생성 SQL에는 이 CHECK가 빠져 있어 여기서 다시 붙인다.
    CONSTRAINT "Order_owner_exactly_one" CHECK (
        ("tableSessionId" IS NOT NULL AND "counterSaleId" IS NULL)
     OR ("tableSessionId" IS NULL AND "counterSaleId" IS NOT NULL)
    )
);
INSERT INTO "new_Order" ("acceptedAt", "cancelReason", "cancelledAt", "counterSaleId", "createdAt", "id", "idempotencyKey", "note", "preparingAt", "readyAt", "rejectReason", "servedAt", "status", "tableSessionId") SELECT "acceptedAt", "cancelReason", "cancelledAt", "counterSaleId", "createdAt", "id", "idempotencyKey", "note", "preparingAt", "readyAt", "rejectReason", "servedAt", "status", "tableSessionId" FROM "Order";
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
    "cancelledAt" DATETIME,
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderItem_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "StaffUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OrderItem" ("id", "menuItemId", "nameSnapshot", "orderId", "quantity", "servingMode", "unitPrice") SELECT "id", "menuItemId", "nameSnapshot", "orderId", "quantity", "servingMode", "unitPrice" FROM "OrderItem";
DROP TABLE "OrderItem";
ALTER TABLE "new_OrderItem" RENAME TO "OrderItem";
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "InventoryItem_deletedAt_idx" ON "InventoryItem"("deletedAt");
