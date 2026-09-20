/**
 * Unit coverage for the cluster-aware delivery pricing algorithm
 * (`src/services/delivery-pricing.service.ts`). Pure arithmetic — no HTTP, no database, no
 * inventory bridge; the endpoint-level behaviour is covered by tests/e2e/delivery-quote.spec.ts.
 *
 * Expected values are recomputed here from first principles (see `tests/helpers/geo.ts`'s
 * independent haversine/clamp reimplementations) rather than by importing the implementation's
 * own helpers, for the same reason that file exists: a test that calls the code under test to
 * compute what the code under test should return proves nothing.
 */
import { describe, expect, it } from 'vitest'

import env from '../../src/config/env'
import { computeBasketDeliveryPricing } from '../../src/services/delivery-pricing.service'
import { independentComputeDeliveryFee, independentHaversineDistanceKm } from '../helpers/geo'

// Navrangpura, Ahmedabad — the same part of the world the live test fixtures use.
const DROP_LATITUDE = 23.0225
const DROP_LONGITUDE = 72.5714

/** Degrees of latitude for a given number of kilometres (longitude held constant), so the test
 *  geometries below can be written in kilometres and read like the scenarios they describe. */
function kmNorth(km: number): number {
  return km / 111.32
}

function shopAt(id: string, kmFromDropNorth: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    latitude: DROP_LATITUDE + kmNorth(kmFromDropNorth),
    longitude: DROP_LONGITUDE,
    deliveryEnabled: true,
    deliveryFeeDefault: 35,
    serviceRadiusKm: 50,
    ...overrides,
  }
}

function expectedIndependentFee(shop: { latitude: number | null; longitude: number | null }): number {
  return independentComputeDeliveryFee(
    independentHaversineDistanceKm(
      shop.latitude as number,
      shop.longitude as number,
      DROP_LATITUDE,
      DROP_LONGITUDE,
    ),
    env.deliveryFeeBase,
    env.deliveryFeePerKm,
    env.deliveryFeeMin,
    env.deliveryFeeMax,
  )
}

function priceBasket(shops: ReturnType<typeof shopAt>[]) {
  return computeBasketDeliveryPricing({
    shops,
    latitude: DROP_LATITUDE,
    longitude: DROP_LONGITUDE,
  })
}

/** Every invariant the rest of the system relies on, asserted together. */
function expectStructurallySound(pricing: ReturnType<typeof priceBasket>): void {
  // Each cluster's fee is exactly the sum of its shops' allocated fees — each shop is its own
  // `Order` row, and those rows must add up to the number the customer was shown.
  pricing.clusters.forEach((cluster, clusterIndex) => {
    const allocated = pricing.perShop
      .filter((entry) => entry.clusterIndex === clusterIndex)
      .reduce((sum, entry) => sum + entry.fee, 0)
    expect(allocated).toBe(cluster.fee)
  })

  // Whole rupees only — `Order.deliveryFee` is an Int column.
  pricing.perShop.forEach((entry) => {
    expect(Number.isInteger(entry.fee)).toBe(true)
    expect(entry.fee).toBeGreaterThanOrEqual(0)
    // No shop ever pays more inside a cluster than it would have paid alone.
    expect(entry.fee).toBeLessThanOrEqual(entry.independentFee)
  })

  expect(pricing.total).toBe(pricing.perShop.reduce((sum, entry) => sum + entry.fee, 0))
  // Clustering may only ever reduce the bill.
  expect(pricing.total).toBeLessThanOrEqual(pricing.independentTotal)
}

describe('computeBasketDeliveryPricing', () => {
  it('leaves a single shop on exactly the old formula: clamp(base + perKm*distance, min, max)', () => {
    const shop = shopAt('solo', 3)
    const pricing = priceBasket([shop])

    expect(pricing.total).toBe(expectedIndependentFee(shop))
    expect(pricing.clusters).toHaveLength(1)
    expect(pricing.clusters[0].combined).toBe(false)
    expect(pricing.perShop[0].isEstimate).toBe(false)
    expect(pricing.savings).toBe(0)
    expectStructurallySound(pricing)
  })

  it('charges ONE route fee for two shops 0.2 km apart, strictly less than two independent fees', () => {
    const near = shopAt('near', 3.0)
    const far = shopAt('far', 3.2)
    const pricing = priceBasket([near, far])

    const independentSum = expectedIndependentFee(near) + expectedIndependentFee(far)

    expect(pricing.clusters).toHaveLength(1)
    expect(pricing.clusters[0].combined).toBe(true)
    expect(pricing.clusters[0].shopIds).toHaveLength(2)
    expect(pricing.total).toBeLessThan(independentSum)
    expect(pricing.independentTotal).toBe(independentSum)
    expect(pricing.savings).toBe(independentSum - pricing.total)

    // The charged route is "farthest shop first, then the nearer one, then the customer":
    // 0.2 km between the shops + ~3.0 km to the drop.
    const gapKm = independentHaversineDistanceKm(
      near.latitude,
      near.longitude,
      far.latitude,
      far.longitude,
    )
    const nearDistanceKm = independentHaversineDistanceKm(
      near.latitude,
      near.longitude,
      DROP_LATITUDE,
      DROP_LONGITUDE,
    )
    expect(pricing.clusters[0].routeKm).toBeCloseTo(gapKm + nearDistanceKm, 5)
    expect(pricing.clusters[0].fee).toBe(
      independentComputeDeliveryFee(
        gapKm + nearDistanceKm,
        env.deliveryFeeBase + env.deliveryExtraPickupFee,
        env.deliveryFeePerKm,
        env.deliveryFeeMin,
        env.deliveryFeeMax,
      ),
    )

    expectStructurallySound(pricing)
  })

  it('keeps two shops 9 km apart in separate clusters, each paying its own full fee', () => {
    // Two points 9 km apart cannot both be 3 km from the same drop (the triangle inequality caps
    // that at 6 km), so this is the closest honest version of "both ~3 km away": 4.5 km each,
    // on opposite sides of the customer.
    const north = shopAt('north', 4.5)
    const south = shopAt('south', -4.5)
    const pricing = priceBasket([north, south])

    expect(pricing.clusters).toHaveLength(2)
    pricing.clusters.forEach((cluster) => expect(cluster.combined).toBe(false))
    expect(pricing.total).toBe(expectedIndependentFee(north) + expectedIndependentFee(south))
    expect(pricing.savings).toBe(0)
    expectStructurallySound(pricing)
  })

  it('splits a cluster fee across its shops so the parts sum to exactly the whole, including the rounding remainder', () => {
    // Deliberately awkward distances so the proportional split lands on fractions of a rupee and
    // the remainder has to go somewhere.
    const pricing = priceBasket([shopAt('a', 2.37), shopAt('b', 2.91), shopAt('c', 3.44)])

    expect(pricing.clusters).toHaveLength(1)
    expect(pricing.clusters[0].combined).toBe(true)
    expect(pricing.perShop.reduce((sum, entry) => sum + entry.fee, 0)).toBe(pricing.clusters[0].fee)
    expectStructurallySound(pricing)
  })

  it('never lets a shop pay more than its own independent fee, even when its raw proportional share would', () => {
    // A shop practically on the customer's doorstep clustered with one 1.4 km away: proportional
    // weighting would hand the far shop ~₹41 of the ₹41 cluster fee, more than the ~₹31 it would
    // have paid alone. The cap pulls it back and the surplus moves to the near shop.
    const doorstep = shopAt('doorstep', 0.01)
    const along = shopAt('along', 1.41)
    const pricing = priceBasket([doorstep, along])

    expect(pricing.clusters).toHaveLength(1)
    expect(pricing.clusters[0].combined).toBe(true)

    const alongEntry = pricing.perShop.find((entry) => entry.shopId === 'along')
    expect(alongEntry?.fee).toBeLessThanOrEqual(expectedIndependentFee(along))
    expectStructurallySound(pricing)
  })

  it('clamps to DELIVERY_FEE_MIN at the door and DELIVERY_FEE_MAX at the far end', () => {
    const atTheDoor = priceBasket([shopAt('door', 0)])
    expect(atTheDoor.total).toBe(env.deliveryFeeMin)

    // Far enough that base + perKm*distance blows past the ceiling (150 / 8 ≈ 16.25 km).
    const veryFar = priceBasket([shopAt('far-away', 60, { serviceRadiusKm: 200 })])
    expect(veryFar.total).toBe(env.deliveryFeeMax)
  })

  it('finds the cheapest pickup order rather than trusting "farthest from the customer first"', () => {
    // Three shops in a line pointing away from the drop. Brute force must land on the ordering
    // that walks inward (far -> middle -> near -> customer), which is the shortest possible.
    const shops = [shopAt('near', 1.0), shopAt('middle', 1.6), shopAt('far', 2.2)]
    const pricing = priceBasket(shops)

    expect(pricing.clusters).toHaveLength(1)

    const distance = (a: (typeof shops)[number], b: (typeof shops)[number]) =>
      independentHaversineDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude)
    const toDrop = (a: (typeof shops)[number]) =>
      independentHaversineDistanceKm(a.latitude, a.longitude, DROP_LATITUDE, DROP_LONGITUDE)

    // Independent brute force over all 3! orderings.
    const orderings = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]
    const shortest = Math.min(
      ...orderings.map(
        (order) =>
          distance(shops[order[0]], shops[order[1]]) +
          distance(shops[order[1]], shops[order[2]]) +
          toDrop(shops[order[2]]),
      ),
    )

    expect(pricing.clusters[0].routeKm).toBeCloseTo(shortest, 5)
    expectStructurallySound(pricing)
  })

  it('chains shops into one cluster transitively, and the detour that creates is paid for in the route', () => {
    // A–B 1.2 km, B–C 1.2 km, A–C 2.4 km (beyond the 1.5 km radius) — single-link puts all three
    // in one cluster, which is safe because L covers the whole 2.4 km walk.
    const pricing = priceBasket([shopAt('a', 1.0), shopAt('b', 2.2), shopAt('c', 3.4)])

    expect(pricing.clusters).toHaveLength(1)
    expect(pricing.clusters[0].shopIds).toHaveLength(3)
    expect(pricing.clusters[0].routeKm).toBeGreaterThan(2.4)
    expectStructurallySound(pricing)
  })

  it('falls back to independent pricing when clustering would somehow cost MORE', () => {
    // With this repo's default constants the combined route is provably never more expensive
    // (base 20 = min 20, so the floor never binds, and the cluster radius bounds the detour), so
    // the guard cannot be reached through geometry alone. It is still load-bearing the moment the
    // constants move — an operator raising the extra-pickup fee is enough — so the test reaches it
    // by temporarily raising that one constant, exactly as an operator's env would.
    const originalExtraPickupFee = env.deliveryExtraPickupFee
    env.deliveryExtraPickupFee = 40

    try {
      const doorstep = shopAt('doorstep', 0.05)
      const along = shopAt('along', 1.45)
      const independentSum = expectedIndependentFee(doorstep) + expectedIndependentFee(along)
      const pricing = priceBasket([doorstep, along])

      // Guard fired: two separate clusters at full price rather than one dearer combined one.
      expect(pricing.clusters).toHaveLength(2)
      pricing.clusters.forEach((cluster) => expect(cluster.combined).toBe(false))
      expect(pricing.total).toBe(independentSum)
      expectStructurallySound(pricing)
    } finally {
      env.deliveryExtraPickupFee = originalExtraPickupFee
    }
  })

  it('never exceeds the independent total across a sweep of geometries', () => {
    for (let firstKm = 0; firstKm <= 6; firstKm += 0.5) {
      for (let secondKm = -6; secondKm <= 6; secondKm += 0.5) {
        const pricing = priceBasket([
          shopAt('one', firstKm, { serviceRadiusKm: 200 }),
          shopAt('two', secondKm, { serviceRadiusKm: 200 }),
        ])
        expectStructurallySound(pricing)
      }
    }
  })

  it('prices a shop with no coordinates at its flat default, flagged as an estimate, and outside every route', () => {
    const mapped = shopAt('mapped', 2)
    const unmapped = shopAt('unmapped', 0, { latitude: null, longitude: null, deliveryFeeDefault: 37 })
    const pricing = priceBasket([mapped, unmapped])

    const unmappedEntry = pricing.perShop.find((entry) => entry.shopId === 'unmapped')
    expect(unmappedEntry?.fee).toBe(37)
    expect(unmappedEntry?.isEstimate).toBe(true)
    expect(unmappedEntry?.distanceKm).toBeNull()
    expect(unmappedEntry?.clusterIndex).toBeNull()

    // The mappable shop is priced exactly as if it were alone — a shop with no coordinates is
    // never silently placed at 0,0 and dragged into somebody's route.
    expect(pricing.perShop.find((entry) => entry.shopId === 'mapped')?.fee).toBe(
      expectedIndependentFee(mapped),
    )
    expect(pricing.total).toBe(expectedIndependentFee(mapped) + 37)
  })

  it('charges nothing for a pickup-only shop and keeps it out of the route', () => {
    const delivering = shopAt('delivering', 2)
    const pickupOnly = shopAt('pickup-only', 2.1, { deliveryEnabled: false })
    const pricing = priceBasket([delivering, pickupOnly])

    expect(pricing.perShop.find((entry) => entry.shopId === 'pickup-only')?.fee).toBe(0)
    expect(pricing.clusters).toHaveLength(1)
    expect(pricing.clusters[0].shopIds).toEqual(['delivering'])
    // Not a free stop on someone else's trip: the delivering shop still pays its own full fee.
    expect(pricing.total).toBe(expectedIndependentFee(delivering))
  })

  it('falls back to flat estimates for every shop when the drop location is unknown', () => {
    const pricing = computeBasketDeliveryPricing({
      shops: [shopAt('a', 1, { deliveryFeeDefault: 30 }), shopAt('b', 1.1, { deliveryFeeDefault: 40 })],
      latitude: null,
      longitude: null,
    })

    expect(pricing.clusters).toHaveLength(0)
    expect(pricing.total).toBe(70)
    expect(pricing.perShop.every((entry) => entry.isEstimate)).toBe(true)
  })

  it('clusters at most five shops and prices the rest independently instead of erroring', () => {
    const shops = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4].map((km, index) => shopAt(`shop-${index}`, km))
    const pricing = priceBasket(shops)

    expect(pricing.perShop).toHaveLength(7)
    // Five clusterable shops become one combined cluster; the two past the cap are their own.
    expect(pricing.clusters.filter((cluster) => cluster.combined)).toHaveLength(1)
    expect(pricing.clusters.filter((cluster) => !cluster.combined)).toHaveLength(2)
    expectStructurallySound(pricing)
  })

  it('gives the same answer whatever order the client lists the basket in', () => {
    const shops = [shopAt('zeta', 1.2), shopAt('alpha', 2.0), shopAt('mid', 1.5)]
    const forwards = priceBasket(shops)
    const backwards = priceBasket([...shops].reverse())

    expect(backwards.total).toBe(forwards.total)
    forwards.perShop.forEach((entry) => {
      expect(backwards.perShop.find((other) => other.shopId === entry.shopId)?.fee).toBe(entry.fee)
    })
  })

  it('names exactly one weather-surcharge bearer per combined cluster', () => {
    const pricing = priceBasket([shopAt('a', 2.0), shopAt('b', 2.3), shopAt('c', 2.6)])

    expect(pricing.clusters).toHaveLength(1)
    expect(pricing.perShop.filter((entry) => entry.bearsWeatherSurcharge)).toHaveLength(1)
  })
})
