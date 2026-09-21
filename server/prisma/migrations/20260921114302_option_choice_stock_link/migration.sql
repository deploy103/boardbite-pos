-- 옵션 선택지에 "재고 품목(메뉴)" 연결을 추가한다.
--
-- 연결하면 그 메뉴의 품절 상태를 선택지가 그대로 따라간다(계란 품절 → '계란 추가' 옵션 자동 품절).
-- 기존 선택지는 전부 linkedMenuItemId=NULL로 복사되므로 지금까지의 동작이 그대로 유지된다.
-- 연결된 메뉴가 나중에 삭제되면 FK가 SET NULL로 풀리고, 선택지는 연결 없는 상태로 계속 팔린다
-- (과거 주문 스냅샷은 OrderItemOption에 따로 저장되어 있어 영향받지 않는다).

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OptionChoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extraPrice" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    "linkedMenuItemId" TEXT,
    CONSTRAINT "OptionChoice_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OptionGroup" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OptionChoice_linkedMenuItemId_fkey" FOREIGN KEY ("linkedMenuItemId") REFERENCES "MenuItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_OptionChoice" ("deletedAt", "extraPrice", "groupId", "id", "isActive", "name", "sortOrder") SELECT "deletedAt", "extraPrice", "groupId", "id", "isActive", "name", "sortOrder" FROM "OptionChoice";
DROP TABLE "OptionChoice";
ALTER TABLE "new_OptionChoice" RENAME TO "OptionChoice";
CREATE INDEX "OptionChoice_groupId_idx" ON "OptionChoice"("groupId");
CREATE INDEX "OptionChoice_linkedMenuItemId_idx" ON "OptionChoice"("linkedMenuItemId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
