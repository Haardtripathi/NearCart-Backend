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

interface BoundingBox {
  minLatitude: number
  maxLatitude: number
  // Null when the box would span (or wrap past) the whole longitude range — because the circle
  // reaches a pole, or crosses the ±180° antimeridian, neither of which a single `BETWEEN` can
  // express. Callers then filter on latitude alone and let the exact haversine pass do the rest.
  minLongitude: number | null
  maxLongitude: number | null
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI
}

// Absorbs floating-point differences between this box and `haversineDistanceKm`'s own
// arithmetic. ~1e-7 degrees is about a centimetre — far below any real coordinate's precision,
// and it only ever widens the box.
const BOUNDING_BOX_EPSILON_DEGREES = 1e-7

/**
 * Bounding box around a point, used as a cheap SQL pre-filter before the exact haversine
 * distance test runs in JS.
 *
 * It is a strict SUPERSET of the circle of the given radius, so pre-filtering on it can never
 * drop a row the exact test would have kept — which is the only property that makes it safe to
 * apply to a customer-visible shop list. That is why the longitude half-width is the exact
 * spherical bound `asin(sin δ / cos φ)` rather than the usual flat-earth `δ / cos φ`: the two
 * agree to a rounding error at Indian latitudes but the approximation is genuinely too narrow
 * further from the equator, which would silently hide shops. The same `EARTH_RADIUS_KM` as
 * `haversineDistanceKm` is used, so the two agree on what "radiusKm" means.
 *
 * The box still admits points up to ~41% farther away in its corners; the exact test discards
 * those.
 */
function buildBoundingBox(
  latitude: number,
  longitude: number,
  radiusKm: number,
): BoundingBox {
  const angularRadius = radiusKm / EARTH_RADIUS_KM
  const latitudeDelta = toDegrees(angularRadius) + BOUNDING_BOX_EPSILON_DEGREES
  const minLatitude = latitude - latitudeDelta
  const maxLatitude = latitude + latitudeDelta

  // A circle that reaches over a pole covers every longitude, and so does one whose half-width
  // is undefined because `sin δ / cos φ` exceeds 1.
  const latitudeCosine = Math.cos(toRadians(latitude))
  const sineRatio = latitudeCosine > 0 ? Math.sin(angularRadius) / latitudeCosine : 2

  if (minLatitude <= -90 || maxLatitude >= 90 || !(sineRatio < 1)) {
    return { minLatitude, maxLatitude, minLongitude: null, maxLongitude: null }
  }

  const longitudeDelta = toDegrees(Math.asin(sineRatio)) + BOUNDING_BOX_EPSILON_DEGREES
  const minLongitude = longitude - longitudeDelta
  const maxLongitude = longitude + longitudeDelta

  if (minLongitude < -180 || maxLongitude > 180) {
    return { minLatitude, maxLatitude, minLongitude: null, maxLongitude: null }
  }

  return { minLatitude, maxLatitude, minLongitude, maxLongitude }
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
 *    `DEFAULT_SERVICE_RADIUS_KM` (env, default 3km) rather than skipping —
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

export { assertWithinServiceArea, buildBoundingBox, computeDeliveryFee, haversineDistanceKm }
export type { BoundingBox }
