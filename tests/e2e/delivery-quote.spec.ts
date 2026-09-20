/**
 * End-to-end coverage for cluster-aware delivery pricing over real HTTP:
 *  - `POST /api/public/delivery-quote` (what the cart screen shows);
 *  - `POST /api/public/cart/validate` with `basketShopIds` (what checkout previews);
 *  - `POST /api/orders` with `basketShopIds` (what the customer is actually charged).
 *
 * The point of the last two is the one that matters commercially: the per-shop `Order.deliveryFee`
 * rows of a multi-shop basket must add up to exactly the single figure the customer was quoted.
 */
import { describe, expect, it, vi } from 'vitest'

import { createInventoryClientMock } from '../helpers/inventory-mock-factory'

vi.mock('../../src/services/inventory-client.service', () => createInventoryClientMock())

import request from 'supertest'

import app from '../../src/app'
import env from '../../src/config/env'
import { createApprovedShop, registerVerifiedCustomer } from '../helpers/fixtures'
import { independentComputeDeliveryFee, independentHaversineDistanceKm } from '../helpers/geo'

const DROP_LATITUDE = 23.0225
const DROP_LONGITUDE = 72.5714

function kmNorth(km: number): number {
  return km / 111.32
}

function independentFeeForKm(distanceKm: number): number {
  return independentComputeDeliveryFee(
    distanceKm,
    env.deliveryFeeBase,
    env.deliveryFeePerKm,
    env.deliveryFeeMin,
    env.deliveryFeeMax,
  )
}

function feeForShopKmNorth(kmFromDrop: number): number {
  return independentFeeForKm(
    independentHaversineDistanceKm(
      DROP_LATITUDE + kmNorth(kmFromDrop),
      DROP_LONGITUDE,
      DROP_LATITUDE,
      DROP_LONGITUDE,
    ),
  )
}

async function createShopKmNorth(kmFromDrop: number, options: Record<string, unknown> = {}) {
  return createApprovedShop({
    latitude: DROP_LATITUDE + kmNorth(kmFromDrop),
    longitude: DROP_LONGITUDE,
    serviceRadiusKm: 50,
    deliveryFeeDefault: 35,
    ...options,
  })
}

function quote(shopIds: string[], latitude = DROP_LATITUDE, longitude = DROP_LONGITUDE) {
  return request(app).post('/api/public/delivery-quote').send({ shopIds, lat: latitude, lng: longitude })
}

describe('POST /api/public/delivery-quote', () => {
  it('prices a single shop exactly as the unchanged single-shop formula does', async () => {
    const shop = await createShopKmNorth(3)

    const response = await quote([shop.shopId])

    expect(response.status).toBe(200)
    expect(response.body.item.total).toBe(feeForShopKmNorth(3))
    expect(response.body.item.clusters).toHaveLength(1)
    expect(response.body.item.clusters[0].combined).toBe(false)
    expect(response.body.item.clusters[0].explanation).toMatch(/km away/)
    expect(response.body.item.savings).toBe(0)
  })

  it('charges one combined fee for two shops 0.2 km apart, and says so in words', async () => {
    const [near, far] = await Promise.all([createShopKmNorth(3.0), createShopKmNorth(3.2)])

    const response = await quote([near.shopId, far.shopId])

    expect(response.status).toBe(200)
    const { item } = response.body
    const independentSum = feeForShopKmNorth(3.0) + feeForShopKmNorth(3.2)

    expect(item.clusters).toHaveLength(1)
    expect(item.clusters[0].combined).toBe(true)
    expect(item.clusters[0].shopIds).toHaveLength(2)
    expect(item.clusters[0].explanation).toMatch(/0\.2 km apart — one trip covers both\./)
    expect(item.total).toBeLessThan(independentSum)
    expect(item.independentTotal).toBe(independentSum)
    expect(item.savings).toBe(independentSum - item.total)

    // The two per-shop shares are exactly the one cluster fee — nothing is lost or invented in
    // the split.
    expect(item.perShop.reduce((sum: number, entry: { fee: number }) => sum + entry.fee, 0)).toBe(item.total)
  })

  it('keeps two shops 9 km apart as two separate trips at two full fees', async () => {
    const [north, south] = await Promise.all([createShopKmNorth(4.5), createShopKmNorth(-4.5)])

    const response = await quote([north.shopId, south.shopId])

    expect(response.status).toBe(200)
    expect(response.body.item.clusters).toHaveLength(2)
    expect(response.body.item.total).toBe(feeForShopKmNorth(4.5) + feeForShopKmNorth(-4.5))
    expect(response.body.item.savings).toBe(0)
  })

  it('dedupes repeated shop ids instead of pricing the same shop twice', async () => {
    const shop = await createShopKmNorth(2)

    const response = await quote([shop.shopId, shop.shopId, shop.shopId])

    expect(response.status).toBe(200)
    expect(response.body.item.perShop).toHaveLength(1)
    expect(response.body.item.total).toBe(feeForShopKmNorth(2))
  })

  it('ignores unknown shop ids rather than failing the whole quote', async () => {
    const shop = await createShopKmNorth(2)

    const response = await quote([shop.shopId, 'not-a-real-shop-id'])

    expect(response.status).toBe(200)
    expect(response.body.item.perShop).toHaveLength(1)
    expect(response.body.item.pricedShopIds).toEqual([shop.shopId])
    expect(response.body.item.total).toBe(feeForShopKmNorth(2))
  })

  it('returns an empty quote (not an error) when every id is unknown', async () => {
    const response = await quote(['ghost-shop-a', 'ghost-shop-b'])

    expect(response.status).toBe(200)
    expect(response.body.item.total).toBe(0)
    expect(response.body.item.clusters).toEqual([])
    expect(response.body.item.perShop).toEqual([])
  })

  it('leaves a shop the drop is outside the service radius of out of the quote', async () => {
    const [inRange, outOfRange] = await Promise.all([
      createShopKmNorth(1.0),
      createShopKmNorth(1.2, { serviceRadiusKm: 0.5 }),
    ])

    const response = await quote([inRange.shopId, outOfRange.shopId])

    expect(response.status).toBe(200)
    expect(response.body.item.pricedShopIds).toEqual([inRange.shopId])
    expect(response.body.item.total).toBe(feeForShopKmNorth(1.0))
  })

  it('charges nothing for a pickup-only shop and does not fold it into anyone else s trip', async () => {
    const [delivering, pickupOnly] = await Promise.all([
      createShopKmNorth(2.0),
      createShopKmNorth(2.1, { deliveryEnabled: false }),
    ])

    const response = await quote([delivering.shopId, pickupOnly.shopId])

    expect(response.status).toBe(200)
    const pickupEntry = response.body.item.perShop.find(
      (entry: { shopId: string }) => entry.shopId === pickupOnly.shopId,
    )
    expect(pickupEntry.fee).toBe(0)
    expect(response.body.item.total).toBe(feeForShopKmNorth(2.0))
  })

  it('rejects absurd input', async () => {
    const shop = await createShopKmNorth(2)

    const noShops = await request(app)
      .post('/api/public/delivery-quote')
      .send({ shopIds: [], lat: DROP_LATITUDE, lng: DROP_LONGITUDE })
    expect(noShops.status).toBe(400)

    const offThePlanet = await quote([shop.shopId], 999, 999)
    expect(offThePlanet.status).toBe(400)

    const tooManyShops = await quote(new Array(40).fill(shop.shopId))
    expect(tooManyShops.status).toBe(400)

    const noCoordinates = await request(app).post('/api/public/delivery-quote').send({ shopIds: [shop.shopId] })
    expect(noCoordinates.status).toBe(400)
  })
})

describe('cluster-aware pricing at cart-validate and checkout', () => {
  it('charges each order its allocated share, and the shares add up to exactly the quote', async () => {
    const [first, second] = await Promise.all([createShopKmNorth(3.0), createShopKmNorth(3.15)])
    const customer = await registerVerifiedCustomer()
    const basketShopIds = [first.shopId, second.shopId]
    const items = [{ productId: 'cluster-product-1', quantity: 1 }]

    const quoteResponse = await quote(basketShopIds)
    expect(quoteResponse.status).toBe(200)
    expect(quoteResponse.body.item.clusters).toHaveLength(1)
    const quotedTotal = quoteResponse.body.item.total as number

    const validated = await Promise.all(
      basketShopIds.map((shopId) =>
        request(app)
          .post('/api/public/cart/validate')
          .send({
            shopId,
            items,
            latitude: DROP_LATITUDE,
            longitude: DROP_LONGITUDE,
            basketShopIds,
          }),
      ),
    )

    validated.forEach((response) => {
      expect(response.status).toBe(200)
      expect(response.body.item.summary.deliveryCluster).not.toBeNull()
      expect(response.body.item.summary.deliveryCluster.shopIds).toHaveLength(2)
    })

    const validatedFees = validated.map((response) => response.body.item.summary.deliveryFee as number)
    expect(validatedFees.reduce((sum, fee) => sum + fee, 0)).toBe(quotedTotal)

    // Every shop's real order must be created at the fee its preview showed — checkout re-derives
    // the clustering itself from `basketShopIds`, it does not take the client's word for it.
    const orderFees: number[] = []

    for (const shopId of basketShopIds) {
      const orderResponse = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          shopId,
          customerName: 'Cluster Customer',
          customerPhone: '9998887777',
          deliveryAddressLine1: '12 Cluster Lane',
          city: 'Ahmedabad',
          pincode: '380009',
          latitude: DROP_LATITUDE,
          longitude: DROP_LONGITUDE,
          paymentMethod: 'COD',
          basketShopIds,
          items,
        })

      expect(orderResponse.status).toBe(201)
      orderFees.push(orderResponse.body.item.deliveryFee as number)
    }

    expect(orderFees.reduce((sum, fee) => sum + fee, 0)).toBe(quotedTotal)
    expect(orderFees).toEqual(validatedFees)
    // And it is genuinely cheaper than two independent deliveries would have been.
    expect(quotedTotal).toBeLessThan(feeForShopKmNorth(3.0) + feeForShopKmNorth(3.15))
  })

  it('leaves single-shop checkout completely unchanged when no basket is declared', async () => {
    const shop = await createShopKmNorth(2.5)
    const items = [{ productId: 'solo-product-1', quantity: 1 }]

    const withoutBasket = await request(app)
      .post('/api/public/cart/validate')
      .send({ shopId: shop.shopId, items, latitude: DROP_LATITUDE, longitude: DROP_LONGITUDE })

    expect(withoutBasket.status).toBe(200)
    expect(withoutBasket.body.item.summary.deliveryFee).toBe(feeForShopKmNorth(2.5))
    expect(withoutBasket.body.item.summary.deliveryCluster).toBeNull()

    // Declaring a basket that is just this one shop must not change anything either.
    const withSelfOnlyBasket = await request(app).post('/api/public/cart/validate').send({
      shopId: shop.shopId,
      items,
      latitude: DROP_LATITUDE,
      longitude: DROP_LONGITUDE,
      basketShopIds: [shop.shopId],
    })

    expect(withSelfOnlyBasket.status).toBe(200)
    expect(withSelfOnlyBasket.body.item.summary.deliveryFee).toBe(feeForShopKmNorth(2.5))
    expect(withSelfOnlyBasket.body.item.summary.deliveryCluster).toBeNull()
  })

  it('ignores a fabricated basket of shops that are nowhere near the drop', async () => {
    const shop = await createShopKmNorth(3.0)
    const faraway = await createShopKmNorth(40, { serviceRadiusKm: 200 })
    const items = [{ productId: 'fabricated-basket-product', quantity: 1 }]

    const response = await request(app).post('/api/public/cart/validate').send({
      shopId: shop.shopId,
      items,
      latitude: DROP_LATITUDE,
      longitude: DROP_LONGITUDE,
      basketShopIds: [shop.shopId, faraway.shopId, 'made-up-shop'],
    })

    expect(response.status).toBe(200)
    // Neither the invented id nor the shop 40 km away can pull this shop's fee down.
    expect(response.body.item.summary.deliveryFee).toBe(feeForShopKmNorth(3.0))
    expect(response.body.item.summary.deliveryCluster).toBeNull()
  })
})
