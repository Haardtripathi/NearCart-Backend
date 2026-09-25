/**
 * Companion to NearCart-Inventory/backend/prisma/seed-areas.ts (2026-09-24 demo reset). Reads its
 * manifest and creates, in NearCart's DB: one approved public Shop per inventory shop (mapped via
 * inventoryOrganizationId/inventoryBranchId, own owner login), one customer per area with a saved
 * default address at the area centre, and the bootstrap admin (ADMIN_BOOTSTRAP_* from .env).
 *
 * Shops get no serviceRadiusKm of their own, so the platform default (3 km) applies.
 *
 * Run with:  node --import tsx prisma/seed-areas-shops.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

import prisma from "../src/lib/prisma";
import { ensureBootstrapAdmin } from "../src/services/bootstrap.service";
import { hashPassword } from "../src/utils/password";

const MANIFEST_PATH =
  process.env.SEED_AREAS_MANIFEST ??
  "/home/kakarot/Projects/NearCart-App/NearCart-Inventory/backend/prisma/seed-areas.manifest.json";

interface Manifest {
  demoPassword: string;
  areas: { key: string; name: string; lat: number; lng: number; pincode: string; locality: string }[];
  shops: {
    shopName: string;
    shopSlug: string;
    shopCategory: string;
    logoImageUrl: string;
    area: string;
    addressLine1: string;
    pincode: string;
    latitude: number;
    longitude: number;
    organizationId: string;
    branchId: string;
    phone: string;
  }[];
}

async function main() {
  const url = (process.env.DATABASE_URL ?? "").replace(/^"|"$/g, "").toLowerCase();
  if (!url.startsWith("libsql://")) {
    throw new Error("Refusing: DATABASE_URL is not the remote libsql database");
  }

  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  const passwordHash = await hashPassword(manifest.demoPassword);

  const admin = await ensureBootstrapAdmin();
  console.log(`Admin: ${admin ? admin.email : "NOT CREATED (ADMIN_BOOTSTRAP_* missing)"}`);

  for (const [index, entry] of manifest.shops.entries()) {
    const owner = await prisma.user.create({
      data: {
        fullName: `${entry.shopName.split(" · ")[0]} Owner`,
        email: `owner.${entry.shopSlug}@nearcart-seed.local`,
        passwordHash,
        role: "SHOP_OWNER",
        isActive: true,
        isVerified: true,
      },
    });
    const ownerProfile = await prisma.shopOwnerProfile.create({
      data: { userId: owner.id, businessName: entry.shopName, isApproved: true },
    });
    const shop = await prisma.shop.create({
      data: {
        ownerProfileId: ownerProfile.id,
        name: entry.shopName,
        slug: entry.shopSlug,
        description: `${entry.shopCategory} in ${entry.area}, Ahmedabad.`,
        logoImageUrl: entry.logoImageUrl,
        category: entry.shopCategory,
        phone: entry.phone,
        email: `contact@${entry.shopSlug}.nearcart-seed.local`,
        addressLine1: entry.addressLine1,
        city: "Ahmedabad",
        area: entry.area,
        pincode: entry.pincode,
        latitude: entry.latitude,
        longitude: entry.longitude,
        openingTime: "07:00",
        closingTime: "23:00",
        publicCatalogEnabled: true,
        inventoryOrganizationId: entry.organizationId,
        inventoryBranchId: entry.branchId,
        deliveryEnabled: true,
        minimumOrderAmount: 0,
        deliveryFeeDefault: 20,
        estimatedDeliveryMinutes: 20 + (index % 3) * 5,
        lastCatalogSyncAt: new Date(),
        isActive: true,
        approvalStatus: "APPROVED",
        isOpenToday: true,
        todayStatusUpdatedAt: new Date(),
      },
    });
    await prisma.shopMembership.create({
      data: { shopId: shop.id, ownerProfileId: ownerProfile.id, role: "OWNER" },
    });
    console.log(`  Shop: ${shop.name}`);
  }

  for (const [index, area] of manifest.areas.entries()) {
    const customer = await prisma.user.create({
      data: {
        fullName: `${["Aarav", "Diya", "Kabir", "Meera"][index]} (${area.name})`,
        email: `customer.${area.key}@nearcart-seed.local`,
        phone: `+919898${String(index + 1).padStart(6, "0")}`,
        passwordHash,
        role: "CUSTOMER",
        isActive: true,
        isVerified: true,
      },
    });
    const address = await prisma.address.create({
      data: {
        userId: customer.id,
        label: "Home",
        fullName: customer.fullName,
        phone: customer.phone!,
        line1: `B-${101 + index}, ${area.locality}`,
        city: "Ahmedabad",
        area: area.name,
        pincode: area.pincode,
        latitude: area.lat,
        longitude: area.lng,
        isDefault: true,
      },
    });
    await prisma.customerProfile.create({
      data: { userId: customer.id, defaultAddressId: address.id },
    });
    console.log(`  Customer: ${customer.email} @ ${area.name}`);
  }

  console.log(`\nShops: ${manifest.shops.length}, customers: ${manifest.areas.length}`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
