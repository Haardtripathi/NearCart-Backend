import { describe, expect, it, vi } from 'vitest'

import { createInventoryClientMock } from '../helpers/inventory-mock-factory'

vi.mock('../../src/services/inventory-client.service', () => createInventoryClientMock())

import request from 'supertest'

import app from '../../src/app'
import env from '../../src/config/env'
import { createApprovedShop } from '../helpers/fixtures'
import { independentComputeDeliveryFee, independentHaversineDistanceKm } from '../helpers/geo'

const SHOP_LATITUDE = 12.9716
const SHOP_LONGITUDE = 77.5946

async function validateCart(params: {
  shopId: string
  latitude?: number
  longitude?: number
  quantity?: number
}) {
  return request(app)
    .post('/api/public/cart/validate')
    .send({
      shopId: params.shopId,
      items: [{ productId: 'fee-formula-product-1', quantity: params.quantity ?? 1 }],
      ...(params.latitude !== undefined ? { latitude: params.latitude } : {}),
      ...(params.longitude !== undefined ? { longitude: params.longitude } : {}),
    })
}

describe('delivery fee formula (POST /public/cart/validate)', () => {
  it('matches clamp(base + perKm*distance, min, max) for a known shop/customer distance', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 100,
      deliveryFeeDefault: 45,
    })

    const customerLatitude = SHOP_LATITUDE + 0.2
    const customerLongitude = SHOP_LONGITUDE + 0.2

    const expectedDistanceKm = independentHaversineDistanceKm(
      SHOP_LATITUDE,
      SHOP_LONGITUDE,
      customerLatitude,
      customerLongitude,
    )
    const expectedFee = independentComputeDeliveryFee(
      expectedDistanceKm,
      env.deliveryFeeBase,
      env.deliveryFeePerKm,
      env.deliveryFeeMin,
      env.deliveryFeeMax,
    )

    const response = await validateCart({
      shopId: shop.shopId,
      latitude: customerLatitude,
      longitude: customerLongitude,
    })

    expect(response.status).toBe(200)
    expect(response.body.item.summary.deliveryFee).toBe(expectedFee)
    // Sanity: prove this is actually a distance-based fee and not a coincidental match with the
    // shop's flat default — otherwise the assertion above could pass for the wrong reason.
    expect(expectedFee).not.toBe(shop.deliveryFeeDefault)
  })

  it('produces a strictly lower fee for a near coordinate than a far one, both within the service radius', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 50,
      deliveryFeeDefault: 45,
    })

    // ~0.5km and ~9km — both comfortably inside serviceRadiusKm, and (given .env.test's
    // DELIVERY_FEE_BASE=20 / DELIVERY_FEE_PER_KM=8 / DELIVERY_FEE_MAX=150) comfortably below the
    // ~16.25km point where the fee clamps to its max, so a strict "near < far" comparison stays
    // meaningful rather than both sides saturating to the same clamped value.
    const nearResponse = await validateCart({
      shopId: shop.shopId,
      latitude: SHOP_LATITUDE + 0.005,
      longitude: SHOP_LONGITUDE,
    })
    const farResponse = await validateCart({
      shopId: shop.shopId,
      latitude: SHOP_LATITUDE + 0.08,
      longitude: SHOP_LONGITUDE,
    })

    expect(nearResponse.status).toBe(200)
    expect(farResponse.status).toBe(200)
    expect(nearResponse.body.item.summary.deliveryFee).toBeLessThan(
      farResponse.body.item.summary.deliveryFee,
    )
  })

  it('falls back to shop.deliveryFeeDefault when customer coordinates are missing', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 50,
      deliveryFeeDefault: 42,
    })

    const response = await validateCart({ shopId: shop.shopId })

    expect(response.status).toBe(200)
    expect(response.body.item.summary.deliveryFee).toBe(42)
  })

  it('falls back to shop.deliveryFeeDefault when shop coordinates are missing (even with customer coordinates present)', async () => {
    const shop = await createApprovedShop({
      // Deliberately no latitude/longitude on the shop.
      serviceRadiusKm: 50,
      deliveryFeeDefault: 37,
    })

    const response = await validateCart({
      shopId: shop.shopId,
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
    })

    expect(response.status).toBe(200)
    expect(response.body.item.summary.deliveryFee).toBe(37)
  })
})
