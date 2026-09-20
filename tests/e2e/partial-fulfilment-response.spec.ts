/**
 * Shop-side PARTIAL FULFILMENT — the customer's half, in this app.
 *
 * The shop found it could only supply part of the order and proposed a reduced version instead
 * of confirming it. NearCart-Inventory owns that proposal (it is read live over the bridge and
 * never stored here); what this app owns is the customer's decision and the customer's BILL.
 *
 * So the things worth testing here are: the proposal reaches the customer at all (order detail +
 * the push webhook), accepting rewrites this app's own order truthfully, declining cancels it,
 * and the coupon/loyalty maths can't leave a discount the reduced order no longer earns.
 */
import { describe, expect, it, vi } from 'vitest'

import { createInventoryClientMock } from '../helpers/inventory-mock-factory'

vi.mock('../../src/services/inventory-client.service', () => createInventoryClientMock())
vi.mock('../../src/services/push-notification.service', () => ({
  sendPushToCustomer: vi.fn(async () => undefined),
  sendPushToTokens: vi.fn(async () => undefined),
}))

import request from 'supertest'

import app from '../../src/app'
import env from '../../src/config/env'
import prisma from '../../src/lib/prisma'
import {
  getInventorySalesOrderStatus,
  respondToInventoryPartialFulfilment,
} from '../../src/services/inventory-client.service'
import { sendPushToCustomer } from '../../src/services/push-notification.service'
import { createApprovedShop, registerVerifiedCustomer } from '../helpers/fixtures'
import { TEST_UNIT_PRICE } from '../helpers/inventory-mock-data'

const statusMock = vi.mocked(getInventorySalesOrderStatus)
const respondMock = vi.mocked(respondToInventoryPartialFulfilment)
const pushMock = vi.mocked(sendPushToCustomer)

interface PlacedOrder {
  id: string
  accessToken: string
  subtotal: number
  deliveryFee: number
  totalAmount: number
  items: Array<{ id: string; inventoryProductId: string | null; quantity: number; price: number }>
}

/**
 * One shop + one customer for the whole file, created lazily on first use. Registration goes
 * through the real auth endpoints, which are rate limited to 20 attempts per 15 minutes — a
 * fresh shop owner and customer per test blows through that budget and fails the tail of the
 * file with a 429 that has nothing to do with what is being tested. Orders are still placed
 * individually (a real checkout each time); only the identities are shared.
 */
let sharedFixture: Promise<{ shopId: string; accessToken: string }> | null = null

function getFixture() {
  if (!sharedFixture) {
    sharedFixture = (async () => {
      const shop = await createApprovedShop({ deliveryFeeDefault: 40, serviceRadiusKm: 50 })
      const customer = await registerVerifiedCustomer()
      return { shopId: shop.shopId, accessToken: customer.accessToken }
    })()
  }

  return sharedFixture
}

/** Places a real checkout (4 of product A + 2 of product B at 100 each = 600 of goods). */
async function placeOrder(options: { couponCode?: string } = {}): Promise<PlacedOrder> {
  const fixture = await getFixture()
  const suffix = Math.random().toString(36).slice(2, 8)

  const response = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${fixture.accessToken}`)
    .send({
      shopId: fixture.shopId,
      customerName: 'Partial Fulfilment Customer',
      customerPhone: '9998887777',
      deliveryAddressLine1: '9 Partial Lane',
      city: 'Test City',
      pincode: '400001',
      paymentMethod: 'COD',
      ...(options.couponCode ? { couponCode: options.couponCode } : {}),
      items: [
        { productId: `pf-a-${suffix}`, quantity: 4 },
        { productId: `pf-b-${suffix}`, quantity: 2 },
      ],
    })

  expect(response.status).toBe(201)
  const order = response.body.item

  return {
    id: order.id,
    accessToken: fixture.accessToken,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    totalAmount: order.totalAmount,
    items: order.items,
  }
}

/**
 * Builds the proposal exactly as NearCart-Inventory's `utils/partialFulfilment.ts` serializes it:
 * the first line reduced 4 -> 2, the second dropped entirely.
 */
function buildProposal(
  order: PlacedOrder,
  overrides: Partial<{ state: string; proposedTotal: number; proposedAmountPayable: number }> = {},
) {
  const [first, second] = order.items

  return {
    state: 'AWAITING_CUSTOMER',
    proposedAt: new Date().toISOString(),
    respondedAt: null,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    note: null,
    removedItems: [
      {
        itemId: 'so-item-2',
        productId: second!.inventoryProductId,
        variantId: `${second!.inventoryProductId}-variant`,
        name: 'Dropped Product',
        variantName: null,
        quantity: 2,
        lineTotal: 2 * TEST_UNIT_PRICE,
        reason: null,
      },
    ],
    reducedItems: [
      {
        itemId: 'so-item-1',
        productId: first!.inventoryProductId,
        variantId: `${first!.inventoryProductId}-variant`,
        name: 'Reduced Product',
        variantName: null,
        fromQuantity: 4,
        toQuantity: 2,
        lineTotal: 2 * TEST_UNIT_PRICE,
      },
    ],
    originalTotal: 600,
    proposedTotal: 200,
    proposedAmountPayable: 200 + order.deliveryFee,
    ...overrides,
  }
}

function mockBridgeProposal(order: PlacedOrder, proposal: unknown) {
  statusMock.mockResolvedValue({
    salesOrderId: 'mock-sales-order',
    orderNumber: 'MOCK-SO-0001',
    status: 'PENDING',
    partialFulfilment: proposal,
  } as never)
}

function respond(order: PlacedOrder, accepted: boolean) {
  return request(app)
    .post(`/api/orders/${order.id}/partial-response`)
    .set('Authorization', `Bearer ${order.accessToken}`)
    .send({ accepted })
}

describe('GET /orders/:orderId — surfacing the shop proposal', () => {
  // Both cases only read; one order is enough and keeps checkout traffic within its own limiter.
  let readOnlyOrder: Promise<PlacedOrder> | null = null
  const getReadOnlyOrder = () => (readOnlyOrder ??= placeOrder())

  it('includes the live proposal from the bridge', async () => {
    const order = await getReadOnlyOrder()
    mockBridgeProposal(order, buildProposal(order))

    const response = await request(app)
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${order.accessToken}`)

    expect(response.status).toBe(200)
    expect(response.body.item.partialFulfilment).toMatchObject({
      state: 'AWAITING_CUSTOMER',
      proposedTotal: 200,
    })
    // Still pending on both sides — a proposal is not a status change.
    expect(response.body.item.status).toBe('PENDING_CONFIRMATION')
  })

  it('fails soft: an unreachable bridge returns the order without the proposal, not an error', async () => {
    const order = await getReadOnlyOrder()
    statusMock.mockRejectedValueOnce(new Error('bridge is down'))

    const response = await request(app)
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${order.accessToken}`)

    expect(response.status).toBe(200)
    expect(response.body.item.partialFulfilment).toBeNull()
    expect(response.body.item.status).toBe('PENDING_CONFIRMATION')
  })
})

describe('POST /orders/:orderId/partial-response — accept', () => {
  it('rewrites the order to match what the customer approved', async () => {
    const order = await placeOrder()
    mockBridgeProposal(order, buildProposal(order))
    respondMock.mockClear()

    const response = await respond(order, true)

    expect(response.status).toBe(200)
    expect(response.body.item.status).toBe('ACCEPTED')
    expect(response.body.item.subtotal).toBe(200)
    expect(response.body.item.totalAmount).toBe(200 + order.deliveryFee)
    expect(response.body.item.items).toHaveLength(1)
    expect(response.body.item.items[0]).toMatchObject({ quantity: 2, lineTotal: 200 })
    expect(response.body.item.discountAdjustments).toEqual([])

    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    })
    expect(stored.status).toBe('ACCEPTED')
    expect(stored.acceptedAt).not.toBeNull()
    expect(stored.inventorySyncStatus).toBe('SYNCED')
    expect(stored.items).toHaveLength(1)
    expect(stored.subtotal).toBe(200)
    expect(stored.totalAmount).toBe(200 + order.deliveryFee)

    // The shop and the driver must be told the revised figure, not the original one.
    expect(respondMock).toHaveBeenCalledTimes(1)
    expect(respondMock.mock.calls[0]![0]).toMatchObject({
      externalOrderId: order.id,
      accepted: true,
      revisedPayment: { amountPayable: 200 + order.deliveryFee, discountTotal: 0 },
    })
  })

  it('drops a coupon whose minimum spend the reduced order no longer meets, and says so', async () => {
    const code = `PFMIN${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    await prisma.coupon.create({
      data: {
        code,
        description: 'Partial fulfilment minimum-spend test',
        discountType: 'FLAT',
        discountValue: 50,
        // The order is placed at a 600 subtotal (eligible); the reduced order is 200 (not).
        minOrderAmount: 500,
        isActive: true,
        perUserLimit: 0,
      },
    })

    const order = await placeOrder({ couponCode: code })
    expect(order.totalAmount).toBe(600 + order.deliveryFee - 50)

    mockBridgeProposal(order, buildProposal(order))
    respondMock.mockClear()

    const response = await respond(order, true)

    expect(response.status).toBe(200)
    expect(response.body.item.discountAmount).toBe(0)
    expect(response.body.item.couponCode).toBeNull()
    // Discount removed -> the customer owes the full reduced bill, no phantom saving.
    expect(response.body.item.totalAmount).toBe(200 + order.deliveryFee)
    expect(response.body.item.discountAdjustments).toHaveLength(1)
    expect(response.body.item.discountAdjustments[0]).toMatchObject({ type: 'COUPON', code })
    expect(response.body.item.discountAdjustments[0].message).toMatch(/minimum/i)

    // The corrected figure is what crosses the bridge, so the driver collects the right amount.
    expect(respondMock.mock.calls[0]![0]).toMatchObject({
      revisedPayment: { discountTotal: 0, couponCode: null, amountPayable: 200 + order.deliveryFee },
    })

    // The code is given back: it never actually discounted anything in the end.
    const redemptions = await prisma.couponRedemption.count({ where: { orderId: order.id } })
    expect(redemptions).toBe(0)
    const coupon = await prisma.coupon.findUniqueOrThrow({ where: { code } })
    expect(coupon.timesRedeemed).toBe(0)
  })

  it('never leaves a discount larger than the reduced order', async () => {
    const code = `PFBIG${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    await prisma.coupon.create({
      data: {
        code,
        description: 'Partial fulfilment over-discount test',
        discountType: 'FLAT',
        discountValue: 300,
        minOrderAmount: 0,
        isActive: true,
        perUserLimit: 0,
      },
    })

    const order = await placeOrder({ couponCode: code })
    // Proposal reduces the basket to a single unit — below the 300 discount already applied.
    const proposal = buildProposal(order)
    proposal.reducedItems[0]!.toQuantity = 1
    proposal.reducedItems[0]!.lineTotal = TEST_UNIT_PRICE
    proposal.proposedTotal = TEST_UNIT_PRICE

    mockBridgeProposal(order, proposal)

    const response = await respond(order, true)

    expect(response.status).toBe(200)
    const preDiscountTotal = TEST_UNIT_PRICE + order.deliveryFee
    expect(response.body.item.discountAmount).toBeLessThanOrEqual(preDiscountTotal)
    expect(response.body.item.totalAmount).toBeGreaterThanOrEqual(0)
    expect(response.body.item.totalAmount).toBe(
      Math.max(0, preDiscountTotal - response.body.item.discountAmount),
    )
  })
})

describe('POST /orders/:orderId/partial-response — decline and guards', () => {
  it('cancels the order when the customer refuses', async () => {
    const order = await placeOrder()
    mockBridgeProposal(order, buildProposal(order))
    respondMock.mockClear()

    const response = await respond(order, false)

    expect(response.status).toBe(200)
    expect(response.body.item.status).toBe('CANCELLED')

    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    })
    expect(stored.status).toBe('CANCELLED')
    // A refused proposal changes nothing about what was ordered — only that it won't happen.
    expect(stored.items).toHaveLength(2)
    expect(stored.subtotal).toBe(600)

    expect(respondMock.mock.calls[0]![0]).toMatchObject({ accepted: false })
    expect(respondMock.mock.calls[0]![0]).not.toHaveProperty('revisedPayment')
  })

  // Neither guard case mutates the order, so they share one.
  let guardOrder: Promise<PlacedOrder> | null = null
  const getGuardOrder = () => (guardOrder ??= placeOrder())

  it('rejects a response when nothing is awaiting the customer', async () => {
    const order = await getGuardOrder()

    mockBridgeProposal(order, null)
    const noProposal = await respond(order, true)
    expect(noProposal.status).toBe(409)
    expect(noProposal.body.message).toMatch(/nothing to approve/i)

    mockBridgeProposal(order, buildProposal(order, { state: 'ACCEPTED' }))
    const alreadyAnswered = await respond(order, true)
    expect(alreadyAnswered.status).toBe(409)
    expect(alreadyAnswered.body.message).toMatch(/already approved/i)

    // Untouched throughout.
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.status).toBe('PENDING_CONFIRMATION')
  })

  it("refuses another customer's order without revealing that it exists", async () => {
    const order = await getGuardOrder()
    const stranger = await registerVerifiedCustomer()
    mockBridgeProposal(order, buildProposal(order))

    const response = await request(app)
      .post(`/api/orders/${order.id}/partial-response`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ accepted: true })

    expect(response.status).toBe(404)
  })
})

describe('POST /internal/order-events — partial fulfilment events', () => {
  async function postEvent(body: Record<string, unknown>) {
    return request(app)
      .post('/api/internal/order-events')
      .set('x-internal-service-token', env.inventoryInternalToken)
      .send(body)
  }

  // A PARTIAL_PROPOSED event deliberately leaves the order PENDING_CONFIRMATION, so the second
  // case can reuse the same order.
  let eventOrder: Promise<PlacedOrder> | null = null
  const getEventOrder = () => (eventOrder ??= placeOrder())

  it('notifies the customer about a proposal, naming the shop and the item counts', async () => {
    const order = await getEventOrder()
    pushMock.mockClear()

    const response = await postEvent({
      externalOrderId: order.id,
      status: 'PENDING',
      eventType: 'PARTIAL_PROPOSED',
      partialFulfilment: buildProposal(order),
    })

    expect(response.status).toBe(200)

    expect(pushMock).toHaveBeenCalledTimes(1)
    const [, payload] = pushMock.mock.calls[0]!
    expect(payload.title).toMatch(/approval/i)
    // 2 items ordered, 1 of them unsuppliable, and one reduced -> the "partly fill" wording.
    expect(payload.body).toMatch(/can only partly fill your order \(1 of 2 items/i)
    expect(payload.data).toMatchObject({ orderId: order.id, eventType: 'PARTIAL_PROPOSED' })

    // A proposal must not move the order's status.
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.status).toBe('PENDING_CONFIRMATION')
  })

  it('ignores an event type it does not know about instead of failing the webhook', async () => {
    const order = await getEventOrder()
    pushMock.mockClear()

    const response = await postEvent({
      externalOrderId: order.id,
      status: 'PENDING',
      eventType: 'SOME_FUTURE_EVENT',
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ received: true, ignored: true })
    expect(pushMock).not.toHaveBeenCalled()

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.status).toBe('PENDING_CONFIRMATION')
  })
})

describe('GET /customer/orders — the "action needed" badge on the list', () => {
  it('flags only the orders actually waiting on the customer, and never errors when the bridge is down', async () => {
    const fixture = await getFixture()
    const awaitingOrder = await placeOrder()

    // Only a proposal still AWAITING_CUSTOMER earns a badge — an already-answered one must not
    // keep nagging the customer from the list.
    statusMock.mockImplementation(async (externalOrderId: string) =>
      ({
        salesOrderId: 'mock-sales-order',
        orderNumber: 'MOCK-SO-0001',
        status: 'PENDING',
        partialFulfilment:
          externalOrderId === awaitingOrder.id
            ? buildProposal(awaitingOrder)
            : buildProposal(awaitingOrder, { state: 'ACCEPTED' }),
      }) as never,
    )

    // Counted below — only the calls this one list request makes.
    statusMock.mockClear()

    const response = await request(app)
      .get('/api/customer/orders')
      .set('Authorization', `Bearer ${fixture.accessToken}`)

    expect(response.status).toBe(200)

    const rows = response.body.items as Array<{ id: string; partialFulfilment: unknown }>
    const flagged = rows.filter((row) => row.partialFulfilment !== null)

    expect(flagged).toHaveLength(1)
    expect(flagged[0]!.id).toBe(awaitingOrder.id)
    expect(flagged[0]!.partialFulfilment).toMatchObject({ state: 'AWAITING_CUSTOMER' })
    // Every other row still comes back, just without a badge.
    expect(rows.length).toBeGreaterThan(1)

    // The list must not fan out one bridge call per order — only plausibly-awaiting ones, capped.
    expect(statusMock.mock.calls.length).toBeLessThanOrEqual(5)

    // Bridge down: the list still renders, just without badges.
    statusMock.mockRejectedValue(new Error('bridge is down'))

    const degraded = await request(app)
      .get('/api/customer/orders')
      .set('Authorization', `Bearer ${fixture.accessToken}`)

    expect(degraded.status).toBe(200)
    expect(degraded.body.items.length).toBe(rows.length)
    expect(
      (degraded.body.items as Array<{ partialFulfilment: unknown }>).every(
        (row) => row.partialFulfilment === null,
      ),
    ).toBe(true)

    statusMock.mockReset()
  })
})
