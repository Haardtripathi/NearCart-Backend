import type { Shop } from '@prisma/client'

import { getInventoryActiveOrderCount } from './inventory-client.service'
import { getWeatherImpact } from './weather.service'
import { haversineDistanceKm } from '../utils/geo'

// Used when a shop hasn't set `estimatedDeliveryMinutes` (prep time) yet.
const DEFAULT_BASE_PREP_MINUTES = 20

// Reasonable average urban delivery speed (walking/two-wheeler mix), used
// to turn straight-line haversine distance into a travel-time term. Not a
// routed/road-network estimate — this is the same order of approximation
// as the rest of the codebase's geo handling (see `assertWithinServiceArea`
// in `orders.service.ts`, which is also haversine-based).
const AVERAGE_DELIVERY_SPEED_KMH = 20

// ~3 minutes of added wait per order already ahead in the queue, capped so
// one very busy shop can't blow the estimate out to something useless.
const QUEUE_MINUTES_PER_ACTIVE_ORDER = 3
const QUEUE_DELAY_CAP_MINUTES = 30

// Clamp so a bad/missing input (e.g. a shop with no prep time and no
// coordinates) can't produce a nonsense number in either direction.
const MIN_ETA_MINUTES = 15
const MAX_ETA_MINUTES = 90

type EtaShop = Pick<
  Shop,
  | 'latitude'
  | 'longitude'
  | 'estimatedDeliveryMinutes'
  | 'inventoryOrganizationId'
  | 'inventoryBranchId'
>

interface DeliveryEtaInput {
  shop: EtaShop
  customerLatitude?: number | null
  customerLongitude?: number | null
  // 'fast'  — used for shop-list views: skips the live weather call and the
  //           live queue-count bridge call (both would mean N external
  //           requests per list render). Falls back to the same stub
  //           weather multiplier `weather.service` itself uses when
  //           unconfigured, and a 0-minute queue term.
  // 'full'  — used for a single shop's detail view: always computes the
  //           live weather + live queue figures.
  mode: 'fast' | 'full'
}

interface DeliveryEtaResult {
  etaMinutes: number
  distanceKm: number | null
  weatherCondition: string
  queueDelayMinutes: number
}

async function resolveQueueDelayMinutes(shop: EtaShop): Promise<number> {
  if (!shop.inventoryOrganizationId || !shop.inventoryBranchId) {
    // No mapped branch to ask — treat as "no queue signal" rather than
    // failing the whole ETA.
    return 0
  }

  try {
    const { activeOrderCount } = await getInventoryActiveOrderCount({
      organizationId: shop.inventoryOrganizationId,
      branchId: shop.inventoryBranchId,
    })

    return Math.min(
      Math.max(activeOrderCount, 0) * QUEUE_MINUTES_PER_ACTIVE_ORDER,
      QUEUE_DELAY_CAP_MINUTES,
    )
  } catch (error) {
    console.warn(
      '[NearKart] Failed to read active-order-count from the inventory bridge for ETA calculation (treating queue delay as 0):',
      error instanceof Error ? error.message : error,
    )
    return 0
  }
}

/**
 * Computes a live, clamped delivery-time estimate for a shop:
 *
 *   etaMinutes = basePrepMinutes
 *              + (distanceKm / speedKmh * 60) * weatherMultiplier
 *              + queueDelayMinutes
 *
 * clamped to [MIN_ETA_MINUTES, MAX_ETA_MINUTES].
 *
 * Missing-data behavior (documented for the task write-up, same spirit as
 * `assertWithinServiceArea`'s doc comment in `orders.service.ts`):
 *  - No shop coordinates, or no customer coordinates yet (e.g. anonymous
 *    browsing before an address is chosen): the travel-time term is
 *    skipped entirely (treated as 0 minutes) rather than erroring.
 *  - Shop not mapped to an inventory branch: the queue term is 0.
 *  - `mode: 'fast'`: weather and queue are never fetched live — weather
 *    uses the same stub multiplier `weather.service` falls back to when
 *    unconfigured (1.1x), queue is 0. This keeps a shop-list render to O(1)
 *    external calls instead of O(shops).
 */
async function getDeliveryEtaMinutes(
  input: DeliveryEtaInput,
): Promise<DeliveryEtaResult> {
  const { shop } = input
  const basePrepMinutes =
    shop.estimatedDeliveryMinutes ?? DEFAULT_BASE_PREP_MINUTES

  let distanceKm: number | null = null

  if (
    shop.latitude != null &&
    shop.longitude != null &&
    input.customerLatitude != null &&
    input.customerLongitude != null
  ) {
    distanceKm = haversineDistanceKm(
      shop.latitude,
      shop.longitude,
      input.customerLatitude,
      input.customerLongitude,
    )
  }

  const travelMinutes =
    distanceKm != null ? (distanceKm / AVERAGE_DELIVERY_SPEED_KMH) * 60 : 0

  let weatherMultiplier = 1.1
  let weatherCondition = 'unknown'
  let queueDelayMinutes = 0

  if (input.mode === 'full') {
    const [weather, queueMinutes] = await Promise.all([
      shop.latitude != null && shop.longitude != null
        ? getWeatherImpact(shop.latitude, shop.longitude)
        : Promise.resolve({ conditionMultiplier: 1.1, condition: 'unknown' }),
      resolveQueueDelayMinutes(shop),
    ])

    weatherMultiplier = weather.conditionMultiplier
    weatherCondition = weather.condition
    queueDelayMinutes = queueMinutes
  }

  const rawEtaMinutes =
    basePrepMinutes + travelMinutes * weatherMultiplier + queueDelayMinutes

  const etaMinutes = Math.round(
    Math.min(Math.max(rawEtaMinutes, MIN_ETA_MINUTES), MAX_ETA_MINUTES),
  )

  return {
    etaMinutes,
    distanceKm: distanceKm != null ? Number(distanceKm.toFixed(2)) : null,
    weatherCondition,
    queueDelayMinutes,
  }
}

export { getDeliveryEtaMinutes }
export type { DeliveryEtaInput, DeliveryEtaResult }
