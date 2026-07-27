/**
 * Companion to NearCart-Inventory/backend/prisma/seed-multi-city.ts — reads that script's
 * manifest (organizationId/branchId per shop, already created + verified against the live
 * Postgres inventory DB) and creates matching approved, publicCatalogEnabled Shop rows here in
 * NearCart's SQLite DB, each mapped via inventoryOrganizationId/inventoryBranchId — the same
 * mapping pattern the existing dev shop ("Owner Verify Central" -> NearCart Grocery Demo org /
 * Main Store branch) already uses.
 *
 * Idempotent: looks up each Shop by slug before creating; already-existing shops (and their
 * owner User/ShopOwnerProfile/ShopMembership) are left untouched and just logged as skipped.
 * Does NOT touch "Owner Verify Central" or any other pre-existing row.
 *
 * Run with:  node --import tsx prisma/seed-multi-city-shops.ts
 */
import { readFileSync } from "node:fs";

import prisma from "../src/lib/prisma";
import { hashPassword } from "../src/utils/password";

const MANIFEST_PATH =
  "/home/kakarot/Projects/NearCart-App/NearCart-Inventory/backend/prisma/seed-multi-city.manifest.json";

interface ManifestShop {
  shopName: string;
  shopSlug: string;
  shopCategory: string;
  city: string;
  logoImageUrl: string;
  latitude: number;
  longitude: number;
  addressArea: string;
  organizationId: string;
  branchId: string;
  productCount: number;
}

interface Manifest {
  generatedAt: string;
  shops: ManifestShop[];
}

// Real-ish pincodes for each seeded locality (v1 dev data — not looked up per-address).
const AREA_PINCODES: Record<string, string> = {
  "Bandra West": "400050",
  Colaba: "400001",
  Indiranagar: "560038",
  Koramangala: "560034",
  "Banjara Hills": "500034",
  "HITEC City": "500081",
  "FC Road": "411004",
  Kothrud: "411038",
};

async function seedShop(manifestShop: ManifestShop, index: number) {
  console.log(`\n--- ${manifestShop.shopName} (${manifestShop.city}) ---`);

  const existing = await prisma.shop.findUnique({ where: { slug: manifestShop.shopSlug } });

  if (existing) {
    console.log(`  Shop already exists: ${existing.id} — skipping create`);
    return { id: existing.id, name: existing.name, created: false };
  }

  const ownerEmail = `owner+${manifestShop.shopSlug}@nearcart-seed.local`;
  const passwordHash = await hashPassword("SeedOwner@123");

  let ownerUser = await prisma.user.findUnique({ where: { email: ownerEmail } });

  if (!ownerUser) {
    ownerUser = await prisma.user.create({
      data: {
        fullName: `${manifestShop.shopName} Owner`,
        email: ownerEmail,
        passwordHash,
        role: "SHOP_OWNER",
        isActive: true,
        isVerified: true,
      },
    });
    console.log(`  Created owner User: ${ownerUser.email}`);
  } else {
    console.log(`  Owner User already exists: ${ownerUser.email}`);
  }

  let ownerProfile = await prisma.shopOwnerProfile.findUnique({
    where: { userId: ownerUser.id },
  });

  if (!ownerProfile) {
    ownerProfile = await prisma.shopOwnerProfile.create({
      data: {
        userId: ownerUser.id,
        businessName: manifestShop.shopName,
        isApproved: true,
      },
    });
    console.log(`  Created ShopOwnerProfile: ${ownerProfile.id}`);
  } else {
    console.log(`  ShopOwnerProfile already exists: ${ownerProfile.id}`);
  }

  const pincode = AREA_PINCODES[manifestShop.addressArea] ?? "000000";
  const phone = `+91900000${String(1000 + index).padStart(4, "0")}`;

  const shop = await prisma.shop.create({
    data: {
      ownerProfileId: ownerProfile.id,
      name: manifestShop.shopName,
      slug: manifestShop.shopSlug,
      description: `${manifestShop.shopName} — ${manifestShop.shopCategory} in ${manifestShop.addressArea}, ${manifestShop.city}.`,
      logoImageUrl: manifestShop.logoImageUrl,
      category: manifestShop.shopCategory,
      phone,
      email: `contact@${manifestShop.shopSlug}.example.com`,
      addressLine1: manifestShop.addressArea,
      city: manifestShop.city,
      area: manifestShop.addressArea,
      pincode,
      latitude: manifestShop.latitude,
      longitude: manifestShop.longitude,
      openingTime: "09:00",
      closingTime: "22:00",
      publicCatalogEnabled: true,
      inventoryOrganizationId: manifestShop.organizationId,
      inventoryBranchId: manifestShop.branchId,
      deliveryEnabled: true,
      minimumOrderAmount: 99,
      deliveryFeeDefault: 25,
      estimatedDeliveryMinutes: 30,
      serviceRadiusKm: 6,
      lastCatalogSyncAt: new Date(),
      isActive: true,
      approvalStatus: "APPROVED",
    },
  });

  await prisma.shopMembership.create({
    data: {
      shopId: shop.id,
      ownerProfileId: ownerProfile.id,
      role: "OWNER",
    },
  });

  console.log(
    `  Created Shop: ${shop.id} (${shop.name}) mapped -> org ${manifestShop.organizationId} / branch ${manifestShop.branchId}`,
  );

  return { id: shop.id, name: shop.name, created: true };
}

async function main() {
  console.log("=== Seeding multi-city Shop rows (NearCart) from Inventory manifest ===");
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  console.log(`Manifest generated at ${manifest.generatedAt}, ${manifest.shops.length} shops`);

  const results = [];
  for (const [index, manifestShop] of manifest.shops.entries()) {
    const result = await seedShop(manifestShop, index);
    results.push(result);
  }

  console.log("\n=== Done ===");
  console.log(
    `Shops created: ${results.filter((r) => r.created).length}, already existed: ${results.filter((r) => !r.created).length}`,
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
