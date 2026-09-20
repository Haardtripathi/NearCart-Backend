/**
 * Regression test for the cross-app MONEY bug: a COD order of item total 360 + delivery fee 74
 * (customer owes 434) reached NearCart-Inventory as a SalesOrder with `total = 360` and nothing
 * else, so the driver app said "COLLECT CASH 360" and neither the shop nor the driver ever learnt
 * the payment method. The bridge push (`pushSalesOrderToInventory`) must now carry a `payment`
 * block whose figures are byte-identical to the Order row / what the customer saw at checkout.
 */
import { describe, expect, it, vi } from 'vitest'

import { createInventoryClientMock } from '../helpers/inventory-mock-factory'

vi.mock('../../src/services/inventory-client.service', () => createInventoryClientMock())

import request from 'supertest'

import app from '../../src/app'
import { pushSalesOrderToInventory } from '../../src/services/inventory-client.service'
import { buildInventoryPaymentPayload } from '../../src/services/orders.service'
import { createApprovedShop, registerVerifiedCustomer } from '../helpers/fixtures'

const pushMock = vi.mocked(pushSalesOrderToInventory)

const baseOrder = {
  paymentMethod: 'COD',
  paymentStatus: 'PENDING',
  subtotal: 360,
  deliveryFee: 74,
  weatherSurchargeFee: 0,
  platformFee: 0,
  discountAmount: 0,
  couponCode: null,
  totalAmount: 434,
} as const

describe('buildInventoryPaymentPayload', () => {
  it('the reproduced case: 360 items + 74 delivery, COD -> amountPayable 434 in whole rupees', () => {
    expect(buildInventoryPaymentPayload(baseOrder)).toEqual({
      method: 'COD',
      status: 'PENDING',
      itemTotal: 360,
      deliveryFee: 74,
      discountTotal: 0,
      amountPayable: 434,
      currency: 'INR',
    })
  })

  it('carries coupon + loyalty + weather surcharge, and the bill still adds up to amountPayable', () => {
    const payment = buildInventoryPaymentPayload(
      {
        ...baseOrder,
        paymentMethod: 'ONLINE',
        paymentStatus: 'PAID',
        weatherSurchargeFee: 15,
        discountAmount: 60,
        couponCode: 'SAVE40',
        totalAmount: 389,
      },
      20,
    )

    expect(payment).toEqual({
      method: 'ONLINE',
      status: 'PAID',
      itemTotal: 360,
      deliveryFee: 74,
      weatherSurchargeFee: 15,
      discountTotal: 60,
      loyaltyDiscount: 20,
      couponCode: 'SAVE40',
      amountPayable: 389,
      currency: 'INR',
    })
    expect(
      payment.itemTotal +
        payment.deliveryFee +
        (payment.weatherSurchargeFee ?? 0) -
        payment.discountTotal,
    ).toBe(payment.amountPayable)
  })

  it('omits the optional keys rather than sending zero/null noise', () => {
    const payment = buildInventoryPaymentPayload(baseOrder, 0)

    expect(payment).not.toHaveProperty('loyaltyDiscount')
    expect(payment).not.toHaveProperty('couponCode')
    expect(payment).not.toHaveProperty('weatherSurchargeFee')
  })
})

describe('POST /orders -> pushSalesOrderToInventory payload', () => {
  it.each(['COD', 'ONLINE', 'PAY_ON_PICKUP'] as const)(
    'pushes a payment block matching the created order exactly (%s)',
    async (paymentMethod) => {
      const shop = await createApprovedShop({
        latitude: 19.076,
        longitude: 72.8777,
        serviceRadiusKm: 30,
        deliveryFeeDefault: 74,
      })
      const customer = await registerVerifiedCustomer()

      pushMock.mockClear()

      const response = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          shopId: shop.shopId,
          customerName: 'Payment Test Customer',
          customerPhone: '9998887777',
          deliveryAddressLine1: '12 Payment Lane',
          city: 'Test City',
          pincode: '400001',
          paymentMethod,
          items: [{ productId: `payment-product-${paymentMethod}`, quantity: 3 }],
        })

      expect(response.status).toBe(201)
      const order = response.body.item

      // Sanity: a real delivery fee is in play, so amountPayable != itemTotal (the whole bug).
      expect(order.deliveryFee).toBe(74)
      expect(order.totalAmount).toBe(order.subtotal + order.deliveryFee + order.weatherSurchargeFee)

      expect(pushMock).toHaveBeenCalledTimes(1)
      const pushed = pushMock.mock.calls[0]![0]

      expect(pushed.externalOrderId).toBe(order.id)
      expect(pushed.payment).toEqual({
        method: paymentMethod,
        // No payment gateway exists: every order is PENDING at push time, ONLINE included — the
        // Inventory side must therefore NOT treat "ONLINE" alone as "already paid".
        status: 'PENDING',
        itemTotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        ...(order.weatherSurchargeFee > 0
          ? { weatherSurchargeFee: order.weatherSurchargeFee }
          : {}),
        discountTotal: 0,
        amountPayable: order.totalAmount,
        currency: 'INR',
      })

      // Same unit as the line items pushed next to it (whole rupees).
      const pushedItemTotal = pushed.items.reduce(
        (sum, item) => sum + item.unitPrice * item.quantity,
        0,
      )
      expect(pushed.payment!.itemTotal).toBe(pushedItemTotal)
    },
  )
})
