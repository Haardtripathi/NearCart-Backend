-- Performance indexes — 2026-09-20
--
-- HAND-APPLY THESE. `prisma migrate dev` / `prisma migrate deploy` / `prisma db push` DO NOT
-- WORK against this project's `libsql://` DATABASE_URL — a documented, repeatedly-bitten hazard
-- in this repo. The matching `@@index(...)` entries are already in `prisma/schema.prisma`, but
-- nothing replays them to the live Turso database, so the schema and the real database will
-- silently disagree until someone runs the statements below against Turso by hand:
--
--     turso db shell <database-name> < prisma/manual-ddl/2026-09-20-perf-indexes.sql
--
-- Every statement is `IF NOT EXISTS` and creates an index only — no table, column or row is
-- touched, nothing is dropped, and re-running the file is a no-op. Index names match Prisma's
-- own `<Table>_<columns>_idx` convention exactly, so a future `prisma migrate diff` sees these
-- as the indexes the schema asks for rather than as drift to recreate.
--
-- On a large table each CREATE INDEX takes a full scan to build; on the current dataset they
-- are instant. Verify afterwards with:
--     SELECT name FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name;

-- The public shop directory: every customer-facing query filters approved + active +
-- storefront-enabled, then narrows by latitude for the hyperlocal bounding box. The existing
-- single-column indexes on those three columns are each low-cardinality (3 values, 2, 2), so
-- SQLite can use only one of them and still scans most of the table.
CREATE INDEX IF NOT EXISTS "Shop_approvalStatus_isActive_publicCatalogEnabled_latitude_idx"
  ON "Shop" ("approvalStatus", "isActive", "publicCatalogEnabled", "latitude");

-- Shop-type filtering (`?category=`) on the path where no customer coordinates are supplied and
-- the bounding box above therefore does not apply.
CREATE INDEX IF NOT EXISTS "Shop_category_idx" ON "Shop" ("category");

-- GET /api/customer/orders — one customer's orders, newest first. Without the createdAt column
-- in the index, SQLite sorts that customer's entire order history on every page load.
CREATE INDEX IF NOT EXISTS "Order_customerUserId_createdAt_idx"
  ON "Order" ("customerUserId", "createdAt");

-- The unattended inventory-sync retry sweep (jobs/inventory-sync-retry-sweep.ts) scans for
-- FAILED syncs in a specific status on every tick, forever.
CREATE INDEX IF NOT EXISTS "Order_inventorySyncStatus_status_idx"
  ON "Order" ("inventorySyncStatus", "status");

-- GET /api/public/shops/:shopIdOrSlug/reviews — one shop's reviews, newest first, paginated.
CREATE INDEX IF NOT EXISTS "OrderReview_shopId_createdAt_idx"
  ON "OrderReview" ("shopId", "createdAt");

-- The address book is always read for one user, default address first. The existing
-- `Address_isDefault_idx` is a boolean over the whole table and is effectively unusable on its
-- own; leading with userId turns the read into an index scan.
CREATE INDEX IF NOT EXISTS "Address_userId_isDefault_idx"
  ON "Address" ("userId", "isDefault");

-- The per-user redemption count checked on every coupon preview and again inside checkout.
CREATE INDEX IF NOT EXISTS "CouponRedemption_couponId_userId_idx"
  ON "CouponRedemption" ("couponId", "userId");

-- Expo reports back push tokens that have been deactivated, and they are deleted by token
-- alone. The `(ownerId, expoPushToken)` unique index cannot serve that lookup, because the
-- delete does not know the owner — so today it is a full scan of DeviceToken.
CREATE INDEX IF NOT EXISTS "DeviceToken_expoPushToken_idx"
  ON "DeviceToken" ("expoPushToken");

-- The loyalty summary reads one profile's newest 50 ledger entries.
CREATE INDEX IF NOT EXISTS "LoyaltyLedgerEntry_customerProfileId_createdAt_idx"
  ON "LoyaltyLedgerEntry" ("customerProfileId", "createdAt");

-- getLoyaltyRedemptionForOrder() looks an entry up by its order on every order-detail load;
-- `orderId` has no index at all today.
CREATE INDEX IF NOT EXISTS "LoyaltyLedgerEntry_orderId_idx"
  ON "LoyaltyLedgerEntry" ("orderId");
