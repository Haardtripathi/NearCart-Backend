-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNumber" TEXT NOT NULL,
    "customerUserId" TEXT,
    "shopId" TEXT NOT NULL,
    "shopRecordId" TEXT,
    "shopName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "paymentMethod" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "deliveryAddressId" TEXT,
    "deliveryAddressLabel" TEXT,
    "deliveryAddressLine1" TEXT NOT NULL,
    "deliveryAddressLine2" TEXT,
    "city" TEXT NOT NULL,
    "area" TEXT,
    "pincode" TEXT NOT NULL,
    "landmark" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "notes" TEXT,
    "subtotal" INTEGER NOT NULL,
    "deliveryFee" INTEGER NOT NULL DEFAULT 0,
    "platformFee" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" INTEGER NOT NULL,
    "placedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "deliveredAt" DATETIME,
    "inventorySalesOrderId" TEXT,
    "inventorySalesOrderNumber" TEXT,
    "inventorySyncStatus" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
    "inventorySyncError" TEXT,
    "inventoryLastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_shopRecordId_fkey" FOREIGN KEY ("shopRecordId") REFERENCES "Shop" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("acceptedAt", "area", "city", "createdAt", "customerEmail", "customerName", "customerPhone", "customerUserId", "deliveredAt", "deliveryAddressId", "deliveryAddressLabel", "deliveryAddressLine1", "deliveryAddressLine2", "deliveryFee", "id", "landmark", "latitude", "longitude", "notes", "orderNumber", "paymentMethod", "paymentStatus", "pincode", "placedAt", "platformFee", "shopId", "shopName", "shopRecordId", "status", "subtotal", "totalAmount", "updatedAt") SELECT "acceptedAt", "area", "city", "createdAt", "customerEmail", "customerName", "customerPhone", "customerUserId", "deliveredAt", "deliveryAddressId", "deliveryAddressLabel", "deliveryAddressLine1", "deliveryAddressLine2", "deliveryFee", "id", "landmark", "latitude", "longitude", "notes", "orderNumber", "paymentMethod", "paymentStatus", "pincode", "placedAt", "platformFee", "shopId", "shopName", "shopRecordId", "status", "subtotal", "totalAmount", "updatedAt" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");
CREATE INDEX "Order_customerUserId_idx" ON "Order"("customerUserId");
CREATE INDEX "Order_shopId_idx" ON "Order"("shopId");
CREATE INDEX "Order_shopRecordId_idx" ON "Order"("shopRecordId");
CREATE INDEX "Order_status_idx" ON "Order"("status");
CREATE INDEX "Order_inventorySalesOrderId_idx" ON "Order"("inventorySalesOrderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

