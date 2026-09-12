/**
 * Companion to NearCart-Inventory/backend/prisma/seed-near-me.ts — reads that script's manifest
 * and creates matching approved, publicCatalogEnabled Shop rows here in NearCart's DB, mapped via
 * inventoryOrganizationId/inventoryBranchId. Modeled directly on seed-multi-city-shops.ts.
 *
 * Idempotent: looks up each Shop by slug before creating.
 *
 * Run with:  node --import tsx prisma/seed-near-me-shops.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

import prisma from "../src/lib/prisma";
import { hashPassword } from "../src/utils/password";

const MANIFEST_PATH =
  "/home/kakarot/Projects/NearCart-App/NearCart-Inventory/backend/prisma/seed-near-me.manifest.json";

interface ManifestShop {
  shopName: string;
  shopSlug: string;
  shopCategory: string;
  logoImageUrl: string;
  latitude: number;
  longitude: number;
  addressArea: string;
  organizationId: string;
  branchId: string;
  productCount: number;
  ownerEmail: string;
  ownerPassword: string;
}

interface Manifest {
  generatedAt: string;
  shops: ManifestShop[];
}

async function seedShop(manifestShop: ManifestShop, index: number) {
  console.log(`\n--- ${manifestShop.shopName} ---`);

  const existing = await prisma.shop.findUnique({ where: { slug: manifestShop.shopSlug } });

  if (existing) {
    console.log(`  Shop already exists: ${existing.id} — skipping create`);
    return { id: existing.id, name: existing.name, created: false, ownerEmail: manifestShop.ownerEmail };
  }

  // Same seed password for every shop owner here (NearCart's own owner account, separate login
  // from the Inventory-side ORG_ADMIN account seed-near-me.ts created — two different apps, two
  // different User tables) — matches manifestShop.ownerPassword so the credentials file only
  // needs to record one password per shop's "family" rather than two unrelated random ones.
  const ownerEmail = `nearcart-owner+${manifestShop.shopSlug}@nearcart-seed.local`;
  const passwordHash = await hashPassword(manifestShop.ownerPassword);

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
    console.log(`  Created NearCart owner User: ${ownerUser.email}`);
  } else {
    console.log(`  NearCart owner User already exists: ${ownerUser.email}`);
  }

  let ownerProfile = await prisma.shopOwnerProfile.findUnique({ where: { userId: ownerUser.id } });

  if (!ownerProfile) {
    ownerProfile = await prisma.shopOwnerProfile.create({
      data: { userId: ownerUser.id, businessName: manifestShop.shopName, isApproved: true },
    });
    console.log(`  Created ShopOwnerProfile: ${ownerProfile.id}`);
  }

  const phone = `+91900001${String(1000 + index).padStart(4, "0")}`;

  const shop = await prisma.shop.create({
    data: {
      ownerProfileId: ownerProfile.id,
      name: manifestShop.shopName,
      slug: manifestShop.shopSlug,
      description: `${manifestShop.shopName} — ${manifestShop.shopCategory} in ${manifestShop.addressArea}.`,
      logoImageUrl: manifestShop.logoImageUrl,
      category: manifestShop.shopCategory,
      phone,
      email: `contact@${manifestShop.shopSlug}.example.com`,
      addressLine1: manifestShop.addressArea,
      city: "Ahmedabad",
      area: manifestShop.addressArea,
      pincode: "382424",
      latitude: manifestShop.latitude,
      longitude: manifestShop.longitude,
      openingTime: "08:00",
      closingTime: "23:00",
      publicCatalogEnabled: true,
      inventoryOrganizationId: manifestShop.organizationId,
      inventoryBranchId: manifestShop.branchId,
      deliveryEnabled: true,
      minimumOrderAmount: 0,
      deliveryFeeDefault: 15,
      estimatedDeliveryMinutes: 25,
      // Generous on purpose — this is throwaway test data meant to reliably show up as "nearby"
      // for live-device testing, not a realistic delivery-radius value.
      serviceRadiusKm: 10,
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

  console.log(`  Created Shop: ${shop.id} (${shop.name}) mapped -> org ${manifestShop.organizationId} / branch ${manifestShop.branchId}`);

  return { id: shop.id, name: shop.name, created: true, ownerEmail };
}

async function main() {
  console.log("=== Seeding 'near me' Shop rows (NearCart) from Inventory manifest ===");
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  console.log(`Manifest generated at ${manifest.generatedAt}, ${manifest.shops.length} shops`);

  const results = [];
  for (const [index, manifestShop] of manifest.shops.entries()) {
    const result = await seedShop(manifestShop, index);
    results.push(result);
  }

  console.log("\n=== Done ===");
  console.log(`Shops created: ${results.filter((r) => r.created).length}, already existed: ${results.filter((r) => !r.created).length}`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
