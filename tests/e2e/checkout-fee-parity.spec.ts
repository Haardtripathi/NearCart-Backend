/**
 * Regression test for the price-drift class of bug fixed 2026-08-09 (see NearCart CLAUDE.md /
 * project memory `nearcart_cross_app_scenario_sweep_2026-08-09`): `POST /public/cart/validate`
 * (cart preview) and `POST /orders` (real checkout) must compute the EXACT identical delivery fee
 * (and therefore total) for the exact identical shop + items + customer coordinates. They share
 * `buildValidatedCartSnapshot` (public-storefront.service.ts) under the hood, but `createOrderLocked`
 * (orders.service.ts) used to resolve customer coordinates AFTER calling into that shared snapshot
 * function, silently leaving checkout unable to compute a distance-based fee even when validate
 * could — this test exercises the fixed ordering end to end over real HTTP.
 */
import { describe, expect, it, vi } from 'vitest'

import { createInventoryClientMock } from '../helpers/inventory-mock-factory'

vi.mock('../../src/services/inventory-client.service', () => createInventoryClientMock())

import request from 'supertest'

import app from '../../src/app'
import { createApprovedShop, registerVerifiedCustomer } from '../helpers/fixtures'

const SHOP_LATITUDE = 19.076
const SHOP_LONGITUDE = 72.8777

describe('checkout fee parity: POST /public/cart/validate vs POST /orders', () => {
  it('computes byte-identical deliveryFee/subtotal/weatherSurchargeFee/totalAmount for the same shop, items, and coordinates', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 30,
      deliveryFeeDefault: 50,
    })
    const customer = await registerVerifiedCustomer()

    // ~7.6km from the shop — well inside the 30km service radius, and far enough from the flat
    // deliveryFeeDefault (50) that an accidental match wouldn't make this assertion vacuous.
    const customerLatitude = SHOP_LATITUDE + 0.05
    const customerLongitude = SHOP_LONGITUDE + 0.05
    const items = [{ productId: 'parity-product-1', quantity: 2 }]

    const validateResponse = await request(app).post('/api/public/cart/validate').send({
      shopId: shop.shopId,
      items,
      latitude: customerLatitude,
      longitude: customerLongitude,
    })

    expect(validateResponse.status).toBe(200)
    const validateSummary = validateResponse.body.item.summary

    const checkoutResponse = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({
        shopId: shop.shopId,
        customerName: 'Test Customer',
        customerPhone: '9998887777',
        deliveryAddressLine1: '456 Checkout Lane',
        city: 'Test City',
        pincode: '400001',
        latitude: customerLatitude,
        longitude: customerLongitude,
        paymentMethod: 'COD',
        items,
      })

    expect(checkoutResponse.status).toBe(201)
    const order = checkoutResponse.body.item

    // The core regression assertion: both paths agree exactly.
    expect(order.deliveryFee).toBe(validateSummary.deliveryFee)
    expect(order.subtotal).toBe(validateSummary.subtotal)
    expect(order.weatherSurchargeFee).toBe(validateSummary.weatherSurchargeFee)
    expect(order.totalAmount).toBe(validateSummary.totalAmount)

    // Sanity: prove a real distance-based fee was actually computed on both paths (not just that
    // they agree on nothing happening / both silently fell back to the flat default).
    expect(validateSummary.deliveryFee).not.toBe(shop.deliveryFeeDefault)
    expect(validateSummary.deliveryFee).toBeGreaterThan(0)
  })

  it('still agrees when coordinates are omitted on both calls (both fall back to the same flat deliveryFeeDefault)', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 30,
      deliveryFeeDefault: 61,
    })
    const customer = await registerVerifiedCustomer()
    const items = [{ productId: 'parity-product-2', quantity: 1 }]

    const validateResponse = await request(app).post('/api/public/cart/validate').send({
      shopId: shop.shopId,
      items,
    })

    expect(validateResponse.status).toBe(200)
    expect(validateResponse.body.item.summary.deliveryFee).toBe(61)

    const checkoutResponse = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({
        shopId: shop.shopId,
        customerName: 'Test Customer',
        customerPhone: '9998887777',
        deliveryAddressLine1: '456 No-Coordinates Lane',
        city: 'Test City',
        pincode: '400001',
        paymentMethod: 'COD',
        items,
      })

    expect(checkoutResponse.status).toBe(201)
    expect(checkoutResponse.body.item.deliveryFee).toBe(61)
    expect(checkoutResponse.body.item.deliveryFee).toBe(
      validateResponse.body.item.summary.deliveryFee,
    )
  })
})
