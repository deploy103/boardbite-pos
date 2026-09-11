-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "changeAmount" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "tenderedAmount" INTEGER;

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isCash" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "OperationSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "orderingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "paymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "kdsWarnAfterSeconds" INTEGER NOT NULL DEFAULT 300,
    "kdsDangerAfterSeconds" INTEGER NOT NULL DEFAULT 600,
    "servedRevertWindowSeconds" INTEGER NOT NULL DEFAULT 180,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Table" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" INTEGER NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "publicSlug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "ordersLocked" BOOLEAN NOT NULL DEFAULT false,
    "paymentsLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Table" ("createdAt", "id", "name", "number", "publicSlug", "sortOrder", "status") SELECT "createdAt", "id", "name", "number", "publicSlug", "sortOrder", "status" FROM "Table";
DROP TABLE "Table";
ALTER TABLE "new_Table" RENAME TO "Table";
CREATE UNIQUE INDEX "Table_number_key" ON "Table"("number");
CREATE UNIQUE INDEX "Table_publicSlug_key" ON "Table"("publicSlug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_code_key" ON "PaymentMethod"("code");
