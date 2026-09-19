/*
  Warnings:

  - You are about to drop the column `token` on the `TableSession` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "CustomerDeviceSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableSessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "CustomerDeviceSession_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClosingSettlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "openedAt" DATETIME NOT NULL,
    "closedAt" DATETIME NOT NULL,
    "expectedCash" INTEGER NOT NULL,
    "actualCash" INTEGER NOT NULL,
    "cashDifference" INTEGER NOT NULL,
    "totalRevenue" INTEGER NOT NULL,
    "totalDiscount" INTEGER NOT NULL,
    "totalRefund" INTEGER NOT NULL,
    "totalVoid" INTEGER NOT NULL,
    "closedById" TEXT NOT NULL,
    "note" TEXT,
    "snapshot" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClosingSettlement_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "StaffUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "hashVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AuditLog" ("action", "actorId", "actorType", "createdAt", "hash", "id", "metadata", "prevHash", "targetId", "targetType") SELECT "action", "actorId", "actorType", "createdAt", "hash", "id", "metadata", "prevHash", "targetId", "targetType" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE TABLE "new_StaffUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustResetPassword" BOOLEAN NOT NULL DEFAULT false,
    "isBootstrap" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authVersion" INTEGER NOT NULL DEFAULT 1,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretEncrypted" TEXT
);
INSERT INTO "new_StaffUser" ("createdAt", "displayName", "id", "isActive", "isBootstrap", "lastLoginAt", "mustResetPassword", "passwordHash", "role", "username") SELECT "createdAt", "displayName", "id", "isActive", "isBootstrap", "lastLoginAt", "mustResetPassword", "passwordHash", "role", "username" FROM "StaffUser";
DROP TABLE "StaffUser";
ALTER TABLE "new_StaffUser" RENAME TO "StaffUser";
CREATE UNIQUE INDEX "StaffUser_username_key" ON "StaffUser"("username");
CREATE TABLE "new_TableSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joinCodeHash" TEXT,
    "joinCodeIssuedAt" DATETIME,
    "guestCount" INTEGER,
    "note" TEXT,
    "openedById" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "closeReason" TEXT,
    CONSTRAINT "TableSession_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TableSession_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "StaffUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TableSession" ("closeReason", "closedAt", "guestCount", "id", "note", "openedAt", "openedById", "status", "tableId") SELECT "closeReason", "closedAt", "guestCount", "id", "note", "openedAt", "openedById", "status", "tableId" FROM "TableSession";
DROP TABLE "TableSession";
ALTER TABLE "new_TableSession" RENAME TO "TableSession";
CREATE INDEX "TableSession_tableId_status_idx" ON "TableSession"("tableId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDeviceSession_tokenHash_key" ON "CustomerDeviceSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerDeviceSession_tableSessionId_idx" ON "CustomerDeviceSession"("tableSessionId");

-- CreateIndex
CREATE INDEX "CustomerDeviceSession_expiresAt_idx" ON "CustomerDeviceSession"("expiresAt");

-- CreateIndex
CREATE INDEX "ClosingSettlement_closedAt_idx" ON "ClosingSettlement"("closedAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");
