-- 옵션 그룹의 선택 개수를 required/multiSelect 두 불리언에서 minSelect/maxSelect 범위로 통일한다.
--
-- 데이터 보존: 기존 값을 그대로 옮긴다(의미가 1:1로 대응한다).
--   required=true  → minSelect 1   (반드시 하나 골라야 함)
--   required=false → minSelect 0   (선택 사항)
--   multiSelect=true  → maxSelect NULL (제한 없음)
--   multiSelect=false → maxSelect 1    (단일 선택)
-- 따라서 이 migration 이후에도 모든 기존 그룹의 동작이 완전히 동일하다.
-- 이제 "최소 2개, 최대 3개" 같은 임의 범위도 표현할 수 있다.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OptionGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" DATETIME,
    CONSTRAINT "OptionGroup_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_OptionGroup" ("deletedAt", "id", "isActive", "menuItemId", "name", "sortOrder", "minSelect", "maxSelect")
SELECT "deletedAt", "id", "isActive", "menuItemId", "name", "sortOrder",
       CASE WHEN "required" = 1 THEN 1 ELSE 0 END,
       CASE WHEN "multiSelect" = 1 THEN NULL ELSE 1 END
  FROM "OptionGroup";
DROP TABLE "OptionGroup";
ALTER TABLE "new_OptionGroup" RENAME TO "OptionGroup";
CREATE INDEX "OptionGroup_menuItemId_idx" ON "OptionGroup"("menuItemId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
