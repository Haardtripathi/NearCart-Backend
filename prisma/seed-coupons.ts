/**
 * Seeds a handful of starter coupons for the round-2 promo/coupon feature — there's no
 * shop-owner/admin CRUD UI for `Coupon` yet (v1, matches how OrderReview shipped without a
 * moderation UI), so codes are seeded directly the same way as this directory's other seed
 * scripts. Idempotent: upserts by `code`, safe to re-run.
 *
 * Run with:  node --import tsx prisma/seed-coupons.ts
 *
 * Standalone script — must load dotenv itself (see seed-multi-city-shops.ts's note) or
 * src/config/env.ts falls back to the local `file:./prisma/nearkart.db` default instead of the
 * real Turso DB.
 */
import 'dotenv/config'

import prisma from '../src/lib/prisma'

const COUPONS: Array<Parameters<typeof prisma.coupon.upsert>[0]['create']> = [
  {
    code: 'WELCOME50',
    description: 'Flat ₹50 off your first order',
    discountType: 'FLAT',
    discountValue: 50,
    minOrderAmount: 200,
    perUserLimit: 1,
  },
  {
    code: 'SAVE10',
    description: '10% off, up to ₹100',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minOrderAmount: 300,
    maxDiscountAmount: 100,
    perUserLimit: 3,
  },
  {
    code: 'FLAT20',
    description: 'Flat ₹20 off orders above ₹150',
    discountType: 'FLAT',
    discountValue: 20,
    minOrderAmount: 150,
    perUserLimit: 5,
  },
]

async function main() {
  for (const coupon of COUPONS) {
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: coupon,
      create: coupon,
    })
    console.log(`Upserted coupon ${coupon.code}`)
  }
}

main()
  .catch((error) => {
    console.error('Coupon seed failed:', error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
