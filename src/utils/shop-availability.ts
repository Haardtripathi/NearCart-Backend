/**
 * Daily shop open/closed status. A shop owner must explicitly confirm their shop is open (or
 * closed, with an optional reason) each day before customers can order from it — if nothing's
 * been said yet today, the shop shows as "not yet confirmed" rather than silently defaulting to
 * open or closed.
 *
 * "Today" is judged against the SAME UTC day-boundary convention already established in
 * `orders.service.ts`'s `createOrderNumber` (`setUTCHours(0, 0, 0, 0)` / plain UTC
 * year/month/date comparison) rather than inventing a separate timezone approach for this
 * feature — deliberately not the `Asia/Kolkata`-based convention `isShopOpenNow` in
 * `public-storefront.service.ts` uses for the static opening/closing-time check; these are two
 * independently-computed notions of "is the shop open" and this file deliberately doesn't merge
 * them into one calculation. They ARE reconciled one level up though — see `mapPublicShopSummary`
 * in `public-storefront.service.ts`, which forces its `isOpenNow` field to `false` whenever this
 * function's `todayStatus` is `CLOSED`, so the public API response itself never contradicts its
 * own more-authoritative field.
 */

import { createHttpError } from './httpError'

type ShopTodayStatus = 'OPEN' | 'CLOSED' | 'PENDING_CONFIRMATION'

interface ShopTodayStatusSource {
  isOpenToday: boolean | null
  todayStatusUpdatedAt: Date | null
}

function getShopTodayStatus(shop: ShopTodayStatusSource): ShopTodayStatus {
  if (shop.todayStatusUpdatedAt == null) {
    return 'PENDING_CONFIRMATION'
  }

  const now = new Date()
  const updatedAt = shop.todayStatusUpdatedAt
  const isSameUtcDay =
    updatedAt.getUTCFullYear() === now.getUTCFullYear() &&
    updatedAt.getUTCMonth() === now.getUTCMonth() &&
    updatedAt.getUTCDate() === now.getUTCDate()

  if (!isSameUtcDay) {
    return 'PENDING_CONFIRMATION'
  }

  return shop.isOpenToday ? 'OPEN' : 'CLOSED'
}

interface ShopOpenTodayAssertionSource extends ShopTodayStatusSource {
  name: string
  todayStatusReason: string | null
}

/**
 * Blocks an action (checkout, or — since the cart/validate-vs-checkout mismatch fix — cart
 * validation too) unless the shop owner has explicitly confirmed their shop is open TODAY.
 * A shop that's never said anything today, or said so on a previous day, reads as
 * "PENDING_CONFIRMATION" — customers must not be able to place/validate orders against a shop
 * that hasn't actually committed to fulfilling today.
 *
 * Lives here (not in `orders.service.ts`, where it originated) so both `orders.service.ts`
 * (`createOrder`) and `public-storefront.service.ts` (`validatePublicCart`) can share one
 * implementation without a circular import between those two service modules.
 */
function assertShopIsOpenToday(shop: ShopOpenTodayAssertionSource): void {
  const todayStatus = getShopTodayStatus(shop)

  if (todayStatus === 'OPEN') {
    return
  }

  const message =
    todayStatus === 'PENDING_CONFIRMATION'
      ? "This shop hasn't confirmed today's availability yet — check back soon."
      : `This shop is closed today${shop.todayStatusReason ? ` (${shop.todayStatusReason})` : ''}`

  throw createHttpError(403, message, {
    code: 'SHOP_NOT_OPEN_TODAY',
    data: { todayStatus, reason: shop.todayStatusReason ?? null },
  })
}

export { assertShopIsOpenToday, getShopTodayStatus }
export type { ShopOpenTodayAssertionSource, ShopTodayStatus, ShopTodayStatusSource }
