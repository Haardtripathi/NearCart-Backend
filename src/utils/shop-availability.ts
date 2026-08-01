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
 * independent notions of "is the shop open" and aren't meant to be reconciled here.
 */

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

export { getShopTodayStatus }
export type { ShopTodayStatus, ShopTodayStatusSource }
