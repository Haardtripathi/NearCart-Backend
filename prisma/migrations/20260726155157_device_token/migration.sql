-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerType" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "ownerId" TEXT NOT NULL,
    "expoPushToken" TEXT NOT NULL,
    "platform" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceToken_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeviceToken_ownerId_idx" ON "DeviceToken"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_ownerId_expoPushToken_key" ON "DeviceToken"("ownerId", "expoPushToken");
