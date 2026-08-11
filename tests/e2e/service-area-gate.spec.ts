/**
 * Sanity check that the distance-based delivery-fee work didn't break the pre-existing
 * `assertWithinServiceArea` gate (utils/geo.ts) — a customer outside the shop's `serviceRadiusKm`
 * must still be rejected with 400 at both `POST /public/cart/validate` and `POST /orders`.
 *
 * Note on ordering (relevant to why this needs the inventory mock too, not just the two
 * fee-formula spec files): `createOrderLocked` (orders.service.ts) calls
 * `getAuthoritativeCheckoutSnapshot` — which calls `checkInventoryAvailability` — BEFORE it calls
 * `assertWithinServiceArea`. So even an out-of-radius checkout attempt still exercises the
 * (mocked) inventory bridge before being rejected.
 */
import { describe, expect, it, vi } from 'vitest'

import { createInventoryClientMock } from '../helpers/inventory-mock-factory'

vi.mock('../../src/services/inventory-client.service', () => createInventoryClientMock())

import request from 'supertest'

import app from '../../src/app'
import { createApprovedShop, registerVerifiedCustomer } from '../helpers/fixtures'

const SHOP_LATITUDE = 28.6139
const SHOP_LONGITUDE = 77.209
// ~555km north of the shop — nowhere close to a realistic serviceRadiusKm.
const FAR_CUSTOMER_LATITUDE = SHOP_LATITUDE + 5
const FAR_CUSTOMER_LONGITUDE = SHOP_LONGITUDE

describe('service-area gate (assertWithinServiceArea)', () => {
  it('rejects POST /public/cart/validate with 400 when the customer is outside the service radius', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 10,
    })

    const response = await request(app)
      .post('/api/public/cart/validate')
      .send({
        shopId: shop.shopId,
        items: [{ productId: 'gate-product-1', quantity: 1 }],
        latitude: FAR_CUSTOMER_LATITUDE,
        longitude: FAR_CUSTOMER_LONGITUDE,
      })

    expect(response.status).toBe(400)
    expect(response.body.message).toMatch(/only delivers within/i)
  })

  it('rejects POST /orders (checkout) with 400 when the customer is outside the service radius', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 10,
    })
    const customer = await registerVerifiedCustomer()

    const response = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({
        shopId: shop.shopId,
        customerName: 'Test Customer',
        customerPhone: '9998887777',
        deliveryAddressLine1: '456 Faraway Lane',
        city: 'Faraway City',
        pincode: '110099',
        latitude: FAR_CUSTOMER_LATITUDE,
        longitude: FAR_CUSTOMER_LONGITUDE,
        paymentMethod: 'COD',
        items: [{ productId: 'gate-product-1', quantity: 1 }],
      })

    expect(response.status).toBe(400)
    expect(response.body.message).toMatch(/only delivers within/i)
  })

  it('sanity check: a customer WITHIN the service radius is accepted at both endpoints', async () => {
    const shop = await createApprovedShop({
      latitude: SHOP_LATITUDE,
      longitude: SHOP_LONGITUDE,
      serviceRadiusKm: 10,
      deliveryFeeDefault: 30,
    })
    const customer = await registerVerifiedCustomer()
    const nearLatitude = SHOP_LATITUDE + 0.01
    const nearLongitude = SHOP_LONGITUDE

    const validateResponse = await request(app)
      .post('/api/public/cart/validate')
      .send({
        shopId: shop.shopId,
        items: [{ productId: 'gate-product-2', quantity: 1 }],
        latitude: nearLatitude,
        longitude: nearLongitude,
      })

    expect(validateResponse.status).toBe(200)

    const checkoutResponse = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({
        shopId: shop.shopId,
        customerName: 'Test Customer',
        customerPhone: '9998887777',
        deliveryAddressLine1: '789 Nearby Lane',
        city: 'Test City',
        pincode: '110001',
        latitude: nearLatitude,
        longitude: nearLongitude,
        paymentMethod: 'COD',
        items: [{ productId: 'gate-product-2', quantity: 1 }],
      })

    expect(checkoutResponse.status).toBe(201)
  })
})
