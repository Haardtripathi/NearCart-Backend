-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "inventoryProductId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "inventoryVariantId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "unitLabel" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logoImageUrl" TEXT,
    "category" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "area" TEXT,
    "pincode" TEXT NOT NULL,
    "latitude" REAL,
    "longitude" REAL,
    "openingTime" TEXT,
    "closingTime" TEXT,
    "publicCatalogEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inventoryOrganizationId" TEXT,
    "inventoryBranchId" TEXT,
    "deliveryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minimumOrderAmount" INTEGER NOT NULL DEFAULT 0,
    "deliveryFeeDefault" INTEGER NOT NULL DEFAULT 0,
    "estimatedDeliveryMinutes" INTEGER,
    "serviceRadiusKm" REAL,
    "lastCatalogSyncAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Shop_ownerProfileId_fkey" FOREIGN KEY ("ownerProfileId") REFERENCES "ShopOwnerProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Shop" ("addressLine1", "addressLine2", "approvalStatus", "area", "category", "city", "closingTime", "createdAt", "description", "email", "id", "isActive", "latitude", "longitude", "name", "openingTime", "ownerProfileId", "phone", "pincode", "slug", "updatedAt") SELECT "addressLine1", "addressLine2", "approvalStatus", "area", "category", "city", "closingTime", "createdAt", "description", "email", "id", "isActive", "latitude", "longitude", "name", "openingTime", "ownerProfileId", "phone", "pincode", "slug", "updatedAt" FROM "Shop";
DROP TABLE "Shop";
ALTER TABLE "new_Shop" RENAME TO "Shop";
CREATE UNIQUE INDEX "Shop_slug_key" ON "Shop"("slug");
CREATE INDEX "Shop_ownerProfileId_idx" ON "Shop"("ownerProfileId");
CREATE INDEX "Shop_approvalStatus_idx" ON "Shop"("approvalStatus");
CREATE INDEX "Shop_publicCatalogEnabled_idx" ON "Shop"("publicCatalogEnabled");
CREATE INDEX "Shop_inventoryOrganizationId_idx" ON "Shop"("inventoryOrganizationId");
CREATE INDEX "Shop_inventoryBranchId_idx" ON "Shop"("inventoryBranchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
