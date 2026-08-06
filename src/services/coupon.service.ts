import type { Coupon, Prisma } from '@prisma/client'

import prisma from '../lib/prisma'
import { createHttpError } from '../utils/httpError'

type DbClient = Prisma.TransactionClient | typeof prisma

/**
 * Pure discount math, shared by the advisory preview endpoint and the authoritative
 * checkout-time resolution — `discountType: 'PERCENTAGE'` means `discountValue` is a 1-100
 * percent, `'FLAT'` means `discountValue` is a flat rupee amount. Always capped so a coupon can
 * never discount more than the order was worth (`preDiscountTotal`), and additionally capped by
 * `maxDiscountAmount` for percentage coupons (the flat-rupee ceiling a shop/platform is willing
 * to eat on a percentage-off code).
 */
function computeDiscountAmount(
  coupon: Pick<Coupon, 'discountType' | 'discountValue' | 'maxDiscountAmount'>,
  subtotal: number,
  preDiscountTotal: number,
): number {
  let amount =
    coupon.discountType === 'PERCENTAGE'
      ? Math.floor((subtotal * coupon.discountValue) / 100)
      : coupon.discountValue

  if (coupon.maxDiscountAmount != null) {
    amount = Math.min(amount, coupon.maxDiscountAmount)
  }

  return Math.max(0, Math.min(amount, preDiscountTotal))
}

/**
 * Everything checkable without a per-user DB round trip (that part — `perUserLimit` — is checked
 * separately by the caller since it needs a `count()` query). Returns a reason string (not just
 * a boolean) so both the preview endpoint and the checkout-time 400 error can surface exactly
 * why a code didn't apply, rather than a generic "invalid coupon".
 */
function checkCouponBaseEligibility(
  coupon: Coupon,
  subtotal: number,
): { ok: true } | { ok: false; reason: string } {
  const now = new Date()

  if (!coupon.isActive) {
    return { ok: false, reason: 'This coupon is no longer active.' }
  }

  if (coupon.validFrom && now < coupon.validFrom) {
    return { ok: false, reason: 'This coupon is not active yet.' }
  }

  if (coupon.validUntil && now > coupon.validUntil) {
    return { ok: false, reason: 'This coupon has expired.' }
  }

  if (subtotal < coupon.minOrderAmount) {
    return {
      ok: false,
      reason: `Add items worth ₹${coupon.minOrderAmount - subtotal} more to use this coupon (minimum order ₹${coupon.minOrderAmount}).`,
    }
  }

  if (coupon.usageLimit != null && coupon.timesRedeemed >= coupon.usageLimit) {
    return { ok: false, reason: 'This coupon has been fully redeemed.' }
  }

  return { ok: true }
}

async function findCouponByCode(client: DbClient, code: string): Promise<Coupon | null> {
  return client.coupon.findUnique({ where: { code: code.trim().toUpperCase() } })
}

async function assertPerUserLimit(
  client: DbClient,
  coupon: Coupon,
  userId: string,
): Promise<void> {
  if (coupon.perUserLimit <= 0) {
    return
  }

  const redemptionCount = await client.couponRedemption.count({
    where: { couponId: coupon.id, userId },
  })

  if (redemptionCount >= coupon.perUserLimit) {
    throw createHttpError(400, "You've already used this coupon the maximum number of times.", {
      code: 'COUPON_PER_USER_LIMIT_REACHED',
    })
  }
}

/**
 * Advisory-only preview for the checkout screen's "Apply" button — uses the client-reported
 * `subtotal` (from the local cart), NOT the authoritative server-side cart snapshot. This lets
 * the UI show "You saved ₹X" before the customer submits, but the real, trusted discount is
 * always recomputed inside `orders.service.ts`'s `createOrder()` transaction against
 * `getAuthoritativeCheckoutSnapshot`'s subtotal — same "never trust a client-supplied money
 * figure" posture as the rest of checkout (see `assertCustomerIsVerified`'s doc comment history).
 */
async function previewCoupon(
  userId: string,
  code: string,
  subtotal: number,
): Promise<{ valid: boolean; discountAmount: number; reason: string | null; description: string | null }> {
  const coupon = await findCouponByCode(prisma, code)

  if (!coupon) {
    return { valid: false, discountAmount: 0, reason: 'Invalid coupon code.', description: null }
  }

  const baseEligibility = checkCouponBaseEligibility(coupon, subtotal)

  if (!baseEligibility.ok) {
    return { valid: false, discountAmount: 0, reason: baseEligibility.reason, description: coupon.description }
  }

  const redemptionCount = await prisma.couponRedemption.count({
    where: { couponId: coupon.id, userId },
  })

  if (coupon.perUserLimit > 0 && redemptionCount >= coupon.perUserLimit) {
    return {
      valid: false,
      discountAmount: 0,
      reason: "You've already used this coupon the maximum number of times.",
      description: coupon.description,
    }
  }

  return {
    valid: true,
    discountAmount: computeDiscountAmount(coupon, subtotal, subtotal),
    reason: null,
    description: coupon.description,
  }
}

/**
 * Authoritative checkout-time resolution — called inside `orders.service.ts`'s `createOrder()`
 * transaction, against the real (already-validated) checkout subtotal. Throws a 400 on any
 * ineligibility (invalid code, expired, below minimum, limits reached) rather than silently
 * ignoring the code, so a customer who typo'd or reused an expired code finds out before the
 * order is placed, not after.
 */
async function resolveCouponForCheckout(
  transaction: Prisma.TransactionClient,
  input: { userId: string; code: string; subtotal: number; preDiscountTotal: number },
): Promise<{ coupon: Coupon; discountAmount: number }> {
  const coupon = await findCouponByCode(transaction, input.code)

  if (!coupon) {
    throw createHttpError(400, 'Invalid coupon code.', { code: 'COUPON_INVALID' })
  }

  const baseEligibility = checkCouponBaseEligibility(coupon, input.subtotal)

  if (!baseEligibility.ok) {
    throw createHttpError(400, baseEligibility.reason, { code: 'COUPON_NOT_ELIGIBLE' })
  }

  await assertPerUserLimit(transaction, coupon, input.userId)

  const discountAmount = computeDiscountAmount(coupon, input.subtotal, input.preDiscountTotal)

  return { coupon, discountAmount }
}

/**
 * Second half of applying a coupon — called after the `Order` row exists (a `CouponRedemption`
 * has a required, unique `orderId` FK), in the same transaction as `resolveCouponForCheckout`
 * and the order creation itself. Bumps `Coupon.timesRedeemed` here (not in
 * `resolveCouponForCheckout`) so an order-creation failure after resolution but before this call
 * can't leave a coupon's usage count incremented for an order that never actually landed.
 */
async function recordCouponRedemption(
  transaction: Prisma.TransactionClient,
  input: { couponId: string; userId: string; orderId: string; discountAmount: number },
): Promise<void> {
  await transaction.couponRedemption.create({
    data: {
      couponId: input.couponId,
      userId: input.userId,
      orderId: input.orderId,
      discountAmount: input.discountAmount,
    },
  })

  await transaction.coupon.update({
    where: { id: input.couponId },
    data: { timesRedeemed: { increment: 1 } },
  })
}

export { previewCoupon, recordCouponRedemption, resolveCouponForCheckout }
