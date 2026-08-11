import type { Shop } from '@prisma/client'

import env from '../config/env'
import { createHttpError } from './httpError'

const EARTH_RADIUS_KM = 6371

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * Great-circle distance between two lat/lng points, in kilometers, via the
 * haversine formula.
 */
function haversineDistanceKm(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number {
  const deltaLat = toRadians(toLatitude - fromLatitude)
  const deltaLng = toRadians(toLongitude - fromLongitude)

  const lat1 = toRadians(fromLatitude)
  const lat2 = toRadians(toLatitude)

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return EARTH_RADIUS_KM * c
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Distance-based delivery fee: `baseFee + perKmRate * distanceKm`, clamped to
 * [minFee, maxFee] and rounded to the nearest rupee (money in this schema is `Int`).
 *
 * The base/per-km/min/max constants are placeholder business figures pulled from env
 * (`deliveryFeeBase`/`deliveryFeePerKm`/`deliveryFeeMin`/`deliveryFeeMax`, see `config/env.ts`)
 * — this is a deliberately simple linear formula, not a tuned pricing model. Swap it out once
 * there's real cost data (fuel, driver payout curve, etc.) to base it on.
 */
function computeDeliveryFee(distanceKm: number): number {
  const rawFee = env.deliveryFeeBase + env.deliveryFeePerKm * distanceKm
  return Math.round(clamp(rawFee, env.deliveryFeeMin, env.deliveryFeeMax))
}

/**
 * Service-area gating: rejects checkout (or, since the cart/validate-vs-checkout mismatch fix,
 * cart validation) when the delivery location is farther from the shop than its configured
 * service radius.
 *
 * Lives here (not in `orders.service.ts`, where it originated) so both `orders.service.ts`
 * (`createOrder`) and `public-storefront.service.ts` (`validatePublicCart`) can share one
 * implementation without a circular import between those two service modules.
 *
 * Decisions on missing data (documented for the task write-up):
 *  - Shop has no latitude/longitude set: the check is skipped entirely —
 *    there is nothing to measure against, and blocking every order for
 *    shops that haven't set coordinates yet would be worse than a no-op.
 *  - Shop has coordinates but `serviceRadiusKm` is null: falls back to
 *    `DEFAULT_SERVICE_RADIUS_KM` (env, default 10km) rather than skipping —
 *    a shop with known coordinates should still get *some* hyperlocal
 *    bound, not an unlimited one, even before they've explicitly set a
 *    radius.
 *  - Customer location unknown (no saved address coordinates and no ad-hoc
 *    lat/lng in the payload): the check is skipped — we have no coordinate
 *    to compare against.
 */
function assertWithinServiceArea(
  shop: Pick<Shop, 'name' | 'latitude' | 'longitude' | 'serviceRadiusKm'>,
  customerLatitude: number | null,
  customerLongitude: number | null,
): void {
  if (shop.latitude == null || shop.longitude == null) {
    return
  }

  if (customerLatitude == null || customerLongitude == null) {
    return
  }

  const allowedRadiusKm = shop.serviceRadiusKm ?? env.defaultServiceRadiusKm
  const distanceKm = haversineDistanceKm(
    shop.latitude,
    shop.longitude,
    customerLatitude,
    customerLongitude,
  )

  if (distanceKm > allowedRadiusKm) {
    throw createHttpError(
      400,
      `${shop.name} only delivers within ${allowedRadiusKm}km, and this address is about ${distanceKm.toFixed(1)}km away.`,
      {
        distanceKm: Number(distanceKm.toFixed(2)),
        allowedRadiusKm,
      },
    )
  }
}

export { assertWithinServiceArea, computeDeliveryFee, haversineDistanceKm }
