import type { Order, Prisma } from '@prisma/client'

import prisma from '../lib/prisma'

// 1 point per ₹20 spent (on the post-discount `totalAmount`), rounded down. A flat, simple v1
// rate — no tiering/multipliers — mirrors how OrderReview shipped rating-only before any
// weighting logic. Kept as a named constant (not inlined) so the rate is easy to find/tune later
// and easy to reference from the frontend's "You'll earn ~N points" preview text.
const POINTS_PER_RUPEES = 20

// New feature: loyalty-points redemption at checkout. `LoyaltyLedgerEntry.points`/`reason` were
// already designed to support a negative "spend" entry (see that model's doc comment in
// schema.prisma — "no redemption/spend rows yet" was explicitly framed as a v1 limitation, not a
// permanent one), so this needs no schema change: redemption is just the mirror-image write of
// `awardLoyaltyPointsForOrder` below (decrement instead of increment, a negative ledger row
// instead of positive, reason `'ORDER_REDEEMED'`).
//
// 1 point = ₹1 of discount — simple and easy for a customer to reason about ("I have 340 points,
// that's ₹340 off"), and economically sensible against the 1-point-per-₹20-spent earn rate: spend
// ₹20, earn 1 point, redeem that point later for ₹1 off — a flat 5% future-purchase rebate, which
// is an ordinary, sustainable loyalty-program economics for a business to run (nowhere near
// "spend points, pay nothing" territory).
const POINT_REDEMPTION_VALUE_RUPEES = 1

// Cap how much of a single order's subtotal loyalty points alone can cover — without this, a
// customer sitting on a large point balance could zero out an order entirely (or nearly so) and
// the shop would fulfil a real order for ~₹0, which isn't a real-world-sustainable use of a
// rewards program (most real loyalty programs cap redemption as a percentage of the order for
// exactly this reason). 50% still makes a meaningful dent for a customer with points to spend.
const MAX_REDEMPTION_FRACTION_OF_SUBTOTAL = 0.5

function computeLoyaltyPoints(totalAmount: number): number {
  return Math.max(0, Math.floor(totalAmount / POINTS_PER_RUPEES))
}

/**
 * Authoritative checkout-time resolution of how many loyalty points a customer can actually
 * redeem right now — called inside `orders.service.ts`'s `createOrder()` transaction, mirroring
 * `coupon.service.ts`'s `resolveCouponForCheckout`. Unlike coupon resolution (which hard-rejects
 * an ineligible code with a 400, since the customer typed something specific and deserves to know
 * why it didn't work), this silently *clamps* the requested point count down to whatever's
 * actually usable right now — the client already knows the customer's real-time balance (via
 * `GET /customer/loyalty`) before ever sending a request here, so a mismatch only happens from
 * ordinary staleness (points earned/spent in another tab since the checkout page loaded, or the
 * subtotal itself changing), not from the customer trying to do something invalid. Clamping and
 * proceeding — the same posture this codebase's cart already takes for stock-clamped quantities —
 * is friendlier than bouncing the whole checkout over a number the customer never directly chose.
 *
 * Returns `{ pointsToRedeem: 0, discountAmount: 0 }` (a clean no-op) for any non-positive request,
 * so callers don't need to special-case "customer didn't opt in."
 */
async function resolveLoyaltyRedemptionForCheckout(
  transaction: Prisma.TransactionClient,
  input: { customerUserId: string; requestedPoints: number; subtotal: number },
): Promise<{ pointsToRedeem: number; discountAmount: number }> {
  if (!input.requestedPoints || input.requestedPoints <= 0) {
    return { pointsToRedeem: 0, discountAmount: 0 }
  }

  const profile = await transaction.customerProfile.findUnique({
    where: { userId: input.customerUserId },
    select: { loyaltyPoints: true },
  })

  const availablePoints = Math.max(0, profile?.loyaltyPoints ?? 0)
  const maxPointsByOrderCap = Math.floor(
    (input.subtotal * MAX_REDEMPTION_FRACTION_OF_SUBTOTAL) / POINT_REDEMPTION_VALUE_RUPEES,
  )

  const pointsToRedeem = Math.max(
    0,
    Math.min(Math.floor(input.requestedPoints), availablePoints, maxPointsByOrderCap),
  )

  return {
    pointsToRedeem,
    discountAmount: pointsToRedeem * POINT_REDEMPTION_VALUE_RUPEES,
  }
}

/**
 * Second half of applying a redemption — called after the `Order` row exists (mirrors
 * `coupon.service.ts`'s `recordCouponRedemption` two-step shape: resolve against a pre-order
 * snapshot, then write against the real order once it exists). No separate lock needed here the
 * way `recordCouponRedemption` needed one for cross-*customer* contention on a shared coupon —
 * a customer's own point balance is only ever touched by that same customer's own checkouts, and
 * `orders.service.ts`'s per-customer `kvSetNx` checkout lock already fully serializes those, so
 * there's no concurrent-request race left for this specific balance to close. The conditional
 * `updateMany` (re-checking `loyaltyPoints >= pointsToRedeem`) is still real protection, just
 * against a different hazard: the resolve step above ran against a pre-transaction read that a
 * slow/retried transaction attempt could leave stale by the time this commits.
 */
async function recordLoyaltyRedemption(
  transaction: Prisma.TransactionClient,
  input: { customerUserId: string; orderId: string; pointsToRedeem: number },
): Promise<void> {
  if (input.pointsToRedeem <= 0) {
    return
  }

  const result = await transaction.customerProfile.updateMany({
    where: { userId: input.customerUserId, loyaltyPoints: { gte: input.pointsToRedeem } },
    data: { loyaltyPoints: { decrement: input.pointsToRedeem } },
  })

  if (result.count === 0) {
    // Balance dropped below what was resolved moments ago (another order racing to spend the
    // same points landed first, extremely narrow window) — fail the whole order transaction
    // rather than silently redeem 0 points while still discounting the order as if they were
    // spent. `orders.service.ts` doesn't retry on this specific conflict (unlike the order-number
    // race), so this surfaces as a plain 500 today; acceptable for how narrow the window is, and
    // the customer can simply retry checkout.
    throw new Error('Loyalty point balance changed before this order could be finalized.')
  }

  const profile = await transaction.customerProfile.findUniqueOrThrow({
    where: { userId: input.customerUserId },
    select: { id: true },
  })

  await transaction.loyaltyLedgerEntry.create({
    data: {
      customerProfileId: profile.id,
      orderId: input.orderId,
      points: -input.pointsToRedeem,
      reason: 'ORDER_REDEEMED',
    },
  })
}

/**
 * How many points (and their rupee value) were redeemed against a given order, if any — a pure
 * read against the existing `LoyaltyLedgerEntry` table (no new column needed on `Order` itself).
 * Used by `orders.service.ts`'s `mapOrder` caller so a redemption stays visible on the order
 * detail view after checkout, not just in the one-time checkout response.
 */
async function getLoyaltyRedemptionForOrder(
  orderId: string,
): Promise<{ pointsRedeemed: number; discountAmount: number } | null> {
  const entry = await prisma.loyaltyLedgerEntry.findFirst({
    where: { orderId, reason: 'ORDER_REDEEMED' },
    select: { points: true },
  })

  if (!entry) {
    return null
  }

  const pointsRedeemed = Math.abs(entry.points)

  return {
    pointsRedeemed,
    discountAmount: pointsRedeemed * POINT_REDEMPTION_VALUE_RUPEES,
  }
}

/**
 * Awards loyalty points for an order the moment it reaches DELIVERED — called from both of
 * `orders.service.ts`'s DELIVERED transition points (the polling `refreshOrderStatusFromInventory`
 * fallback and the primary `applyInventoryOrderEvent` webhook path). Idempotent by construction:
 * `Order.loyaltyPointsEarned` starts `null` and is only ever set once here, so callers can invoke
 * this on every DELIVERED sighting of an order without double-crediting — this function itself
 * re-checks `loyaltyPointsEarned == null` before doing anything, so even a caller that forgets to
 * gate on it first is still safe.
 *
 * Never throws — same resilience posture as the rest of the DELIVERED-transition code path (a
 * loyalty-points hiccup must not fail the underlying status update). Silently no-ops for guest/
 * orphaned orders (`customerUserId` null, e.g. the owning User was deleted) since there's no
 * `CustomerProfile` to credit.
 */
async function awardLoyaltyPointsForOrder(
  order: Pick<Order, 'id' | 'customerUserId' | 'totalAmount' | 'loyaltyPointsEarned'>,
): Promise<void> {
  if (!order.customerUserId || order.loyaltyPointsEarned != null) {
    return
  }

  const points = computeLoyaltyPoints(order.totalAmount)

  try {
    await prisma.$transaction(async (transaction) => {
      // Re-check inside the transaction against the live row — the caller's `order` snapshot
      // may be stale by the time this runs (e.g. two DELIVERED-transition code paths racing).
      const freshOrder = await transaction.order.findUnique({
        where: { id: order.id },
        select: { loyaltyPointsEarned: true, customerUserId: true, totalAmount: true },
      })

      if (!freshOrder || freshOrder.loyaltyPointsEarned != null || !freshOrder.customerUserId) {
        return
      }

      const profile = await transaction.customerProfile.update({
        where: { userId: freshOrder.customerUserId },
        data: { loyaltyPoints: { increment: points } },
      })

      await transaction.loyaltyLedgerEntry.create({
        data: {
          customerProfileId: profile.id,
          orderId: order.id,
          points,
          reason: 'ORDER_DELIVERED',
        },
      })

      await transaction.order.update({
        where: { id: order.id },
        data: { loyaltyPointsEarned: points },
      })
    })
  } catch (error) {
    console.warn(
      `[NearKart] Failed to award loyalty points for order ${order.id}:`,
      error instanceof Error ? error.message : error,
    )
  }
}

async function getCustomerLoyaltySummary(userId: string) {
  const profile = await prisma.customerProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      loyaltyPoints: true,
      loyaltyLedger: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, points: true, reason: true, orderId: true, createdAt: true },
      },
    },
  })

  return {
    balance: profile?.loyaltyPoints ?? 0,
    entries: profile?.loyaltyLedger ?? [],
    pointsPerRupees: POINTS_PER_RUPEES,
  }
}

export {
  awardLoyaltyPointsForOrder,
  computeLoyaltyPoints,
  getCustomerLoyaltySummary,
  getLoyaltyRedemptionForOrder,
  POINT_REDEMPTION_VALUE_RUPEES,
  POINTS_PER_RUPEES,
  recordLoyaltyRedemption,
  resolveLoyaltyRedemptionForCheckout,
}
