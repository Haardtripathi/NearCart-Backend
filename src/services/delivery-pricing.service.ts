/**
 * DISTANCE-BASED, CLUSTER-AWARE DELIVERY PRICING.
 *
 * The customer app has a multi-shop basket: one `Order` row per shop, each with its own driver
 * and its own `deliveryFee`. Charging every shop a full independent fee double-charges a customer
 * whose two shops are next door to each other, so shops that are close *to each other* are priced
 * as ONE route instead of two.
 *
 * Formula (all money in whole rupees — `Order.deliveryFee` is an `Int`):
 *
 *   single shop            fee = clamp(BASE + PER_KM * d(S, D), MIN, MAX)      (unchanged)
 *   cluster of k shops     L   = Σ d(Sᵢ, Sᵢ₊₁) + d(S_last, D)                  (shortest ordering)
 *                          fee = clamp(BASE + PER_KM * L + EXTRA_PICKUP*(k-1), MIN, MAX)
 *   basket total           Σ cluster fees (+ flat estimates for unmappable shops)
 *
 * Shops join the same cluster by SINGLE-LINK proximity: Sᵢ and Sⱼ are in one cluster when
 * d(Sᵢ, Sⱼ) <= DELIVERY_CLUSTER_RADIUS_KM. Single-link chaining (A–B close, B–C close, A–C far)
 * is safe here precisely because the fee is charged off the real route length L — a chain that
 * spreads out pays for the detour it creates, and the "never more than independent" guard below
 * catches any case where it still comes out worse.
 *
 * ECONOMICS (deliberate, signed off by the owner): the sibling NearCart-Inventory backend pays
 * each driver off the SAME curve (`DRIVER_FARE_BASE`/`DRIVER_FARE_PER_KM`), and each shop's order
 * still gets its own driver — so a combined fee is a real, bounded subsidy the business absorbs,
 * not a margin optimisation. The cluster radius is what bounds it: shops more than
 * DELIVERY_CLUSTER_RADIUS_KM apart are two genuinely separate trips and pay two full fees.
 *
 * No routing API is involved anywhere — straight-line haversine only, same as every other
 * distance in this codebase.
 */
import type { Shop } from '@prisma/client'

import env from '../config/env'
import prisma from '../lib/prisma'
import { computeDeliveryFee, haversineDistanceKm } from '../utils/geo'

/**
 * Hard ceiling on how many shops one basket may be priced as a cluster. Two reasons, one product
 * and one security: a realistic hyperlocal basket is 1-3 shops, and `basketShopIds` is a
 * client-supplied discount lever (see `resolveBasketDeliveryAllocation`), so the blast radius of
 * someone claiming a huge basket has to be bounded. Shops beyond the cap are not rejected — they
 * are simply priced independently (full per-shop fee), which is the pre-clustering behaviour.
 */
const MAX_CLUSTERED_SHOPS = 5

/**
 * Up to this many shops in one cluster, the shortest route is found by brute force over every
 * ordering (5! = 120 permutations of pure arithmetic, no I/O). "Farthest-from-the-customer first"
 * is only a heuristic and is demonstrably not always optimal, so it is used only above this size
 * — which, given MAX_CLUSTERED_SHOPS, can't currently happen at all. Kept so the function stays
 * correct if the cap is ever raised.
 */
const MAX_EXACT_ROUTE_SHOPS = 5

interface PricingShopInput {
  id: string
  name?: string
  latitude: number | null
  longitude: number | null
  /** `false` = pickup-only: no delivery leg at all, so no fee and no place in any route. */
  deliveryEnabled?: boolean
  /** Flat fallback used only when this shop cannot be measured (no coordinates). */
  deliveryFeeDefault?: number
  serviceRadiusKm?: number | null
}

interface BasketPricingInput {
  shops: PricingShopInput[]
  latitude: number | null
  longitude: number | null
}

interface DeliveryCluster {
  shopIds: string[]
  /** What the customer pays for this one trip, whole rupees. */
  fee: number
  /** Route length actually charged for: inter-shop hops + the final shop→customer hop. */
  routeKm: number
  /** True when this cluster covers more than one shop, i.e. the combining actually happened. */
  combined: boolean
}

interface PerShopFee {
  shopId: string
  /** This shop's `Order.deliveryFee`. Cluster fees are split across their shops; these add up
   *  to exactly the cluster fee (and so to exactly `total`). */
  fee: number
  /** Straight-line shop→customer distance, or null when it could not be measured. */
  distanceKm: number | null
  /** Index into `clusters`, or null when this shop is not part of any routed cluster. */
  clusterIndex: number | null
  /** True when `fee` is the shop's flat default rather than a measured, distance-based amount. */
  isEstimate: boolean
  /** Whether this shop's order carries the basket's weather surcharge for its cluster — one trip
   *  through the weather is one surcharge, so only one shop per combined cluster bears it. */
  bearsWeatherSurcharge: boolean
  /** What this shop would have cost on its own. Never lower than `fee`. */
  independentFee: number
}

interface BasketDeliveryPricing {
  total: number
  clusters: DeliveryCluster[]
  perShop: PerShopFee[]
  /** Σ of every shop's standalone fee — the "before" number clustering is measured against. */
  independentTotal: number
  /** `independentTotal - total`. Zero when nothing was combined. */
  savings: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isMappable(shop: PricingShopInput): boolean {
  return shop.latitude != null && shop.longitude != null
}

/**
 * Fee for one trip that picks up at `orderedShops` (in that order) and finishes at the drop.
 * `routeKm` deliberately omits any approach leg to the first pickup — exactly like the
 * single-shop formula, which only ever charged the shop→customer leg.
 *
 * KNOWN, ACCEPTED CHOICE: a large, spread-out cluster can produce a raw fee above
 * DELIVERY_FEE_MAX and get clamped down, meaning the customer underpays a genuinely long trip.
 * That is the same clamp the single-shop formula has always had, it only ever favours the
 * customer, and the cluster radius already bounds how spread out a cluster can get.
 */
function routeFeeFor(
  orderedShops: PricingShopInput[],
  dropLatitude: number,
  dropLongitude: number,
): { fee: number; routeKm: number } {
  let routeKm = 0

  for (let index = 0; index < orderedShops.length - 1; index += 1) {
    routeKm += haversineDistanceKm(
      orderedShops[index].latitude as number,
      orderedShops[index].longitude as number,
      orderedShops[index + 1].latitude as number,
      orderedShops[index + 1].longitude as number,
    )
  }

  const lastShop = orderedShops[orderedShops.length - 1]
  routeKm += haversineDistanceKm(
    lastShop.latitude as number,
    lastShop.longitude as number,
    dropLatitude,
    dropLongitude,
  )

  const extraPickups = (orderedShops.length - 1) * env.deliveryExtraPickupFee
  const rawFee = env.deliveryFeeBase + env.deliveryFeePerKm * routeKm + extraPickups

  return {
    fee: Math.round(clamp(rawFee, env.deliveryFeeMin, env.deliveryFeeMax)),
    routeKm,
  }
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items]
  }

  const result: T[][] = []

  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)]
    permutations(rest).forEach((tail) => {
      result.push([item, ...tail])
    })
  })

  return result
}

/** Cheapest ordering of a cluster's pickups. Exact (brute force) up to MAX_EXACT_ROUTE_SHOPS,
 *  farthest-from-the-drop-first beyond that. */
function bestRouteFor(
  shops: PricingShopInput[],
  dropLatitude: number,
  dropLongitude: number,
): { fee: number; routeKm: number; orderedShopIds: string[] } {
  if (shops.length > MAX_EXACT_ROUTE_SHOPS) {
    const heuristicOrder = [...shops].sort(
      (a, b) =>
        haversineDistanceKm(b.latitude as number, b.longitude as number, dropLatitude, dropLongitude) -
        haversineDistanceKm(a.latitude as number, a.longitude as number, dropLatitude, dropLongitude),
    )
    const route = routeFeeFor(heuristicOrder, dropLatitude, dropLongitude)

    return { ...route, orderedShopIds: heuristicOrder.map((shop) => shop.id) }
  }

  const orderings = permutations(shops)
  let best = {
    ...routeFeeFor(orderings[0], dropLatitude, dropLongitude),
    orderedShopIds: orderings[0].map((shop) => shop.id),
  }

  for (let index = 1; index < orderings.length; index += 1) {
    const route = routeFeeFor(orderings[index], dropLatitude, dropLongitude)

    if (route.routeKm < best.routeKm) {
      best = { ...route, orderedShopIds: orderings[index].map((shop) => shop.id) }
    }
  }

  return best
}

/** Single-link clustering by shop-to-shop proximity (union-find, radius `DELIVERY_CLUSTER_RADIUS_KM`). */
function clusterShops(shops: PricingShopInput[]): PricingShopInput[][] {
  const parent = shops.map((_, index) => index)

  function find(index: number): number {
    let root = index
    while (parent[root] !== root) {
      root = parent[root]
    }
    let cursor = index
    while (parent[cursor] !== root) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }

  for (let i = 0; i < shops.length; i += 1) {
    for (let j = i + 1; j < shops.length; j += 1) {
      const gapKm = haversineDistanceKm(
        shops[i].latitude as number,
        shops[i].longitude as number,
        shops[j].latitude as number,
        shops[j].longitude as number,
      )

      if (gapKm <= env.deliveryClusterRadiusKm) {
        parent[find(i)] = find(j)
      }
    }
  }

  const groups = new Map<number, PricingShopInput[]>()
  shops.forEach((shop, index) => {
    const root = find(index)
    const group = groups.get(root)
    if (group) {
      group.push(shop)
    } else {
      groups.set(root, [shop])
    }
  })

  return [...groups.values()]
}

/**
 * Splits one cluster's fee back across its shops, because each shop is a separate `Order` row
 * whose `deliveryFee` must add up to exactly what the customer was shown.
 *
 * Weighted by each shop's own shop→customer distance (the far shop is most of the trip, so it
 * carries most of the fee), rounded to whole rupees, with the rounding remainder handed to the
 * largest shares so the sum is exact.
 *
 * Every share is additionally capped at that shop's own independent fee — a shop must never pay
 * MORE inside a cluster than it would have alone, which is possible on raw proportions when one
 * shop's standalone fee is held up by DELIVERY_FEE_MIN. When capping leaves money unallocated,
 * the cluster fee itself comes down to the allocated sum rather than the sum being padded: the
 * customer pays less, and `Σ perShop.fee === cluster.fee` stays exactly true.
 */
function allocateClusterFee(
  clusterFee: number,
  entries: Array<{ shopId: string; weight: number; cap: number }>,
): Map<string, number> {
  const allocation = new Map<string, number>()
  let remaining = clusterFee
  let active = [...entries]

  // Iteratively pin anyone whose proportional share would breach their cap, then re-proportion
  // what's left across the rest (a capped shop's surplus flows to shops still under their cap).
  for (;;) {
    const totalWeight = active.reduce((sum, entry) => sum + entry.weight, 0)
    const overflowing = active.filter((entry) => {
      const share = totalWeight > 0 ? (remaining * entry.weight) / totalWeight : remaining / active.length
      return share > entry.cap
    })

    if (overflowing.length === 0 || active.length === 0) {
      break
    }

    overflowing.forEach((entry) => {
      allocation.set(entry.shopId, entry.cap)
      remaining -= entry.cap
    })
    active = active.filter((entry) => !overflowing.includes(entry))
  }

  const totalWeight = active.reduce((sum, entry) => sum + entry.weight, 0)
  const exactShares = active.map((entry) => ({
    entry,
    share:
      active.length === 0
        ? 0
        : totalWeight > 0
          ? (remaining * entry.weight) / totalWeight
          : remaining / active.length,
  }))

  exactShares.forEach(({ entry, share }) => {
    allocation.set(entry.shopId, Math.min(Math.floor(share), entry.cap))
  })

  // Hand the leftover rupees to the largest shares first, skipping anyone already at their cap.
  let leftover = remaining - exactShares.reduce((sum, { entry }) => sum + (allocation.get(entry.shopId) ?? 0), 0)
  const byShareDescending = [...exactShares].sort((a, b) => b.share - a.share)

  for (const { entry } of byShareDescending) {
    if (leftover <= 0) {
      break
    }
    const current = allocation.get(entry.shopId) ?? 0
    if (current < entry.cap) {
      allocation.set(entry.shopId, current + 1)
      leftover -= 1
    }
  }

  return allocation
}

/**
 * The whole algorithm, as a pure function — no database, no I/O, no clock. `shops` may contain
 * shops that cannot be routed at all; they are handled explicitly rather than guessed at:
 *
 *  - `deliveryEnabled === false` (pickup-only): fee 0, excluded from every route. It is NOT a
 *    free stop on someone else's trip — nobody delivers from it.
 *  - latitude/longitude null: cannot be measured or clustered, so it falls back to its flat
 *    `deliveryFeeDefault` and is flagged `isEstimate`. Never substituted with 0,0 — that is the
 *    Gulf of Guinea and would produce a ~5000 km "distance".
 *  - drop coordinates null: nothing can be measured at all, so every shop falls back to its flat
 *    default and no clustering happens.
 */
function computeBasketDeliveryPricing(input: BasketPricingInput): BasketDeliveryPricing {
  const perShop: PerShopFee[] = []
  const clusters: DeliveryCluster[] = []

  const dropLatitude = input.latitude
  const dropLongitude = input.longitude
  const hasDrop = dropLatitude != null && dropLongitude != null

  const routable: PricingShopInput[] = []

  input.shops.forEach((shop) => {
    if (shop.deliveryEnabled === false) {
      perShop.push({
        shopId: shop.id,
        fee: 0,
        distanceKm: null,
        clusterIndex: null,
        isEstimate: false,
        bearsWeatherSurcharge: true,
        independentFee: 0,
      })
      return
    }

    if (!hasDrop || !isMappable(shop)) {
      const flatFee = shop.deliveryFeeDefault ?? 0
      perShop.push({
        shopId: shop.id,
        fee: flatFee,
        distanceKm: null,
        clusterIndex: null,
        isEstimate: true,
        bearsWeatherSurcharge: true,
        independentFee: flatFee,
      })
      return
    }

    routable.push(shop)
  })

  // Deterministic order, so the allocation a shop gets does not depend on the order the client
  // happened to list the basket in — `POST /orders` for shop A and for shop B must derive the
  // identical split from the identical basket.
  const sortedRoutable = [...routable].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const clusterable = sortedRoutable.slice(0, MAX_CLUSTERED_SHOPS)
  const beyondCap = sortedRoutable.slice(MAX_CLUSTERED_SHOPS)

  const distanceToDrop = new Map<string, number>()
  sortedRoutable.forEach((shop) => {
    distanceToDrop.set(
      shop.id,
      haversineDistanceKm(
        shop.latitude as number,
        shop.longitude as number,
        dropLatitude as number,
        dropLongitude as number,
      ),
    )
  })

  const independentFeeOf = (shopId: string): number => computeDeliveryFee(distanceToDrop.get(shopId) as number)

  function pushSingleShopCluster(shop: PricingShopInput): void {
    const distanceKm = distanceToDrop.get(shop.id) as number
    const fee = independentFeeOf(shop.id)
    clusters.push({ shopIds: [shop.id], fee, routeKm: distanceKm, combined: false })
    perShop.push({
      shopId: shop.id,
      fee,
      distanceKm,
      clusterIndex: clusters.length - 1,
      isEstimate: false,
      bearsWeatherSurcharge: true,
      independentFee: fee,
    })
  }

  clusterShops(clusterable).forEach((group) => {
    if (group.length === 1) {
      pushSingleShopCluster(group[0])
      return
    }

    const route = bestRouteFor(group, dropLatitude as number, dropLongitude as number)
    const independentSum = group.reduce((sum, shop) => sum + independentFeeOf(shop.id), 0)

    // THE GUARD, and it is load-bearing rather than a formality: because the per-shop formula is
    // clamped at DELIVERY_FEE_MIN, two shops that are each a stone's throw from the customer but
    // ~1.4 km from each other genuinely cost MORE as one route (their inter-shop hop plus the
    // extra-pickup fee) than as two floor-priced trips. Clustering must only ever reduce the
    // bill, so in that case the cluster is abandoned and each shop is priced on its own.
    if (route.fee >= independentSum) {
      group
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .forEach(pushSingleShopCluster)
      return
    }

    const allocation = allocateClusterFee(
      route.fee,
      group.map((shop) => ({
        shopId: shop.id,
        weight: distanceToDrop.get(shop.id) as number,
        cap: independentFeeOf(shop.id),
      })),
    )

    const allocatedTotal = group.reduce((sum, shop) => sum + (allocation.get(shop.id) ?? 0), 0)
    const clusterIndex = clusters.length

    clusters.push({
      shopIds: route.orderedShopIds,
      // The charged fee is the allocated sum by construction, so the per-order rows can never
      // disagree with the number the customer was shown (capping can only pull it down).
      fee: allocatedTotal,
      routeKm: route.routeKm,
      combined: true,
    })

    // One trip through the rain is one weather surcharge. The shop carrying the largest share of
    // the fee carries it (ties broken on shop id) — a pure function of the basket + drop, so
    // cart-validate and every per-shop `POST /orders` independently reach the same answer.
    const weatherBearerId = [...group]
      .sort((a, b) => {
        const difference = (allocation.get(b.id) ?? 0) - (allocation.get(a.id) ?? 0)
        return difference !== 0 ? difference : a.id < b.id ? -1 : 1
      })[0].id

    group.forEach((shop) => {
      perShop.push({
        shopId: shop.id,
        fee: allocation.get(shop.id) ?? 0,
        distanceKm: distanceToDrop.get(shop.id) as number,
        clusterIndex,
        isEstimate: false,
        bearsWeatherSurcharge: shop.id === weatherBearerId,
        independentFee: independentFeeOf(shop.id),
      })
    })
  })

  // Anything past the cap is priced exactly as it was before clustering existed.
  beyondCap.forEach(pushSingleShopCluster)

  const total = perShop.reduce((sum, entry) => sum + entry.fee, 0)
  const independentTotal = perShop.reduce((sum, entry) => sum + entry.independentFee, 0)

  return {
    total,
    clusters,
    perShop,
    independentTotal,
    savings: Math.max(0, independentTotal - total),
  }
}

/** Human sentence for one cluster, e.g. "Daily Mart and Shyam are 0.3 km apart — one trip". */
function describeCluster(
  cluster: DeliveryCluster,
  nameOf: (shopId: string) => string,
  spreadKmOf: (shopIds: string[]) => number,
): string {
  if (!cluster.combined) {
    return `${nameOf(cluster.shopIds[0])} is about ${cluster.routeKm.toFixed(1)} km away.`
  }

  const names = cluster.shopIds.map(nameOf)
  const joined =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const spreadKm = spreadKmOf(cluster.shopIds)

  return `${joined} are ${spreadKm.toFixed(1)} km apart — one trip covers ${names.length === 2 ? 'both' : 'all of them'}.`
}

/** Widest shop-to-shop gap inside a cluster — what "0.3 km apart" means for more than two shops. */
function maxPairwiseGapKm(shops: PricingShopInput[]): number {
  let widest = 0

  for (let i = 0; i < shops.length; i += 1) {
    for (let j = i + 1; j < shops.length; j += 1) {
      widest = Math.max(
        widest,
        haversineDistanceKm(
          shops[i].latitude as number,
          shops[i].longitude as number,
          shops[j].latitude as number,
          shops[j].longitude as number,
        ),
      )
    }
  }

  return widest
}

// Mirrors `PUBLIC_SHOP_WHERE` + the mapped-to-inventory pair in public-storefront.service.ts.
// Deliberately re-declared rather than imported: that module imports this one (for the
// cart-validate allocation), and a two-way import between the two service files is exactly the
// kind of cycle this codebase has already been bitten by. Keep the two in step.
const QUOTABLE_SHOP_WHERE = {
  approvalStatus: 'APPROVED' as const,
  isActive: true,
  publicCatalogEnabled: true,
  inventoryOrganizationId: { not: null },
  inventoryBranchId: { not: null },
}

function toPricingShop(shop: Shop): PricingShopInput {
  return {
    id: shop.id,
    name: shop.name,
    latitude: shop.latitude,
    longitude: shop.longitude,
    deliveryEnabled: shop.deliveryEnabled,
    deliveryFeeDefault: shop.deliveryFeeDefault,
    serviceRadiusKm: shop.serviceRadiusKm,
  }
}

/**
 * Only shops that can genuinely be delivered to this drop take part in clustering. A shop the
 * drop is outside the service radius of would be rejected at checkout anyway, so letting it into
 * a cluster would only ever be a way to make someone else's order cheaper.
 */
function isWithinServiceArea(
  shop: PricingShopInput,
  dropLatitude: number | null,
  dropLongitude: number | null,
): boolean {
  if (!isMappable(shop) || dropLatitude == null || dropLongitude == null) {
    return true
  }

  const allowedRadiusKm = shop.serviceRadiusKm ?? env.defaultServiceRadiusKm
  const distanceKm = haversineDistanceKm(
    shop.latitude as number,
    shop.longitude as number,
    dropLatitude,
    dropLongitude,
  )

  return distanceKm <= allowedRadiusKm
}

/**
 * Loads the basket's shops and prices them. Unknown, unapproved, unmapped and out-of-radius ids
 * are dropped silently rather than erroring — a stale basket on a customer's phone is an ordinary
 * situation, not a client bug worth a 4xx.
 */
async function loadBasketShops(
  shopIds: string[],
  latitude: number | null,
  longitude: number | null,
): Promise<PricingShopInput[]> {
  const uniqueIds = [...new Set(shopIds.map((shopId) => shopId.trim()).filter(Boolean))]

  if (uniqueIds.length === 0) {
    return []
  }

  const shops = await prisma.shop.findMany({
    where: {
      ...QUOTABLE_SHOP_WHERE,
      OR: [{ id: { in: uniqueIds } }, { slug: { in: uniqueIds } }],
    },
  })

  return shops
    .map(toPricingShop)
    .filter((shop) => isWithinServiceArea(shop, latitude, longitude))
}

interface DeliveryQuoteInput {
  shopIds: string[]
  latitude: number | null
  longitude: number | null
}

/** `POST /api/public/delivery-quote` — arithmetic plus a single `shop.findMany`. */
async function quoteBasketDelivery(payload: DeliveryQuoteInput) {
  const shops = await loadBasketShops(payload.shopIds, payload.latitude, payload.longitude)

  // Every id was unknown/unmapped/out of range. Deliberately a 200 with an empty quote rather
  // than a 4xx: a stale basket is an ordinary situation, and the client's honest fallback is
  // "show per-shop estimates", which an empty quote expresses exactly.
  const pricing = computeBasketDeliveryPricing({
    shops,
    latitude: payload.latitude,
    longitude: payload.longitude,
  })

  const shopById = new Map(shops.map((shop) => [shop.id, shop]))
  const nameOf = (shopId: string): string => shopById.get(shopId)?.name ?? 'This shop'
  const spreadKmOf = (shopIds: string[]): number =>
    maxPairwiseGapKm(shopIds.map((shopId) => shopById.get(shopId)).filter(Boolean) as PricingShopInput[])

  return {
    item: {
      total: pricing.total,
      independentTotal: pricing.independentTotal,
      savings: pricing.savings,
      currencyCode: 'INR',
      clusters: pricing.clusters.map((cluster) => ({
        shopIds: cluster.shopIds,
        shopNames: cluster.shopIds.map(nameOf),
        fee: cluster.fee,
        routeKm: Number(cluster.routeKm.toFixed(2)),
        combined: cluster.combined,
        explanation: describeCluster(cluster, nameOf, spreadKmOf),
      })),
      perShop: pricing.perShop.map((entry) => ({
        shopId: entry.shopId,
        shopName: nameOf(entry.shopId),
        fee: entry.fee,
        distanceKm: entry.distanceKm == null ? null : Number(entry.distanceKm.toFixed(2)),
        clusterIndex: entry.clusterIndex,
        isEstimate: entry.isEstimate,
        independentFee: entry.independentFee,
      })),
      // Echoed back so a client can tell which of the ids it sent were actually priced.
      pricedShopIds: shops.map((shop) => shop.id),
    },
  }
}

interface BasketAllocationInput {
  /** The shop whose order/cart is being priced. */
  shopId: string
  /** Every shop in the customer's basket, as the client claims it. Never trusted as given. */
  basketShopIds: string[]
  latitude: number | null
  longitude: number | null
}

interface BasketAllocation {
  fee: number
  bearsWeatherSurcharge: boolean
  clusterShopIds: string[]
  combined: boolean
  routeKm: number
  independentFee: number
}

/**
 * The single source of truth shared by `POST /public/cart/validate` and `POST /orders`: given the
 * basket the client claims, re-derive the clustering server-side and return THIS shop's share.
 *
 * `basketShopIds` is a lever the client controls, so nothing about it is taken on faith: the ids
 * are re-loaded from the database (approved + active + publicly mapped only), filtered to shops
 * the drop is genuinely inside the service radius of, deduped, capped at MAX_CLUSTERED_SHOPS, and
 * each shop's allocated share is capped at what that shop would have cost on its own. The worst a
 * fabricated basket can do is make the customer's own order cheaper by the bounded subsidy the
 * owner already accepted — and only by naming real, nearby, deliverable shops.
 *
 * Returns null when clustering does not apply (no basket, one shop, this shop unmappable, no drop
 * coordinates) — callers then keep their existing single-shop behaviour untouched.
 */
async function resolveBasketDeliveryAllocation(
  input: BasketAllocationInput,
): Promise<BasketAllocation | null> {
  if (input.basketShopIds.length === 0 || input.latitude == null || input.longitude == null) {
    return null
  }

  const shops = await loadBasketShops(
    [...input.basketShopIds, input.shopId],
    input.latitude,
    input.longitude,
  )

  const thisShop = shops.find((shop) => shop.id === input.shopId)

  if (!thisShop || shops.length < 2) {
    return null
  }

  const pricing = computeBasketDeliveryPricing({
    shops,
    latitude: input.latitude,
    longitude: input.longitude,
  })

  const entry = pricing.perShop.find((perShop) => perShop.shopId === input.shopId)

  if (!entry || entry.clusterIndex == null || entry.isEstimate) {
    return null
  }

  const cluster = pricing.clusters[entry.clusterIndex]

  return {
    fee: entry.fee,
    bearsWeatherSurcharge: entry.bearsWeatherSurcharge,
    clusterShopIds: cluster.shopIds,
    combined: cluster.combined,
    routeKm: cluster.routeKm,
    independentFee: entry.independentFee,
  }
}

export {
  MAX_CLUSTERED_SHOPS,
  computeBasketDeliveryPricing,
  quoteBasketDelivery,
  resolveBasketDeliveryAllocation,
}

export type {
  BasketAllocation,
  BasketDeliveryPricing,
  DeliveryCluster,
  PerShopFee,
  PricingShopInput,
}
