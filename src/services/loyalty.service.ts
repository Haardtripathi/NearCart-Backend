import type { Order } from '@prisma/client'

import prisma from '../lib/prisma'

// 1 point per ₹20 spent (on the post-discount `totalAmount`), rounded down. A flat, simple v1
// rate — no tiering/multipliers — mirrors how OrderReview shipped rating-only before any
// weighting logic. Kept as a named constant (not inlined) so the rate is easy to find/tune later
// and easy to reference from the frontend's "You'll earn ~N points" preview text.
const POINTS_PER_RUPEES = 20

function computeLoyaltyPoints(totalAmount: number): number {
  return Math.max(0, Math.floor(totalAmount / POINTS_PER_RUPEES))
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

export { awardLoyaltyPointsForOrder, computeLoyaltyPoints, getCustomerLoyaltySummary, POINTS_PER_RUPEES }
