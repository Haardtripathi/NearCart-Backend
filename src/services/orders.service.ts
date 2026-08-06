import type { OrderStatus, Prisma, Shop, UserRole } from '@prisma/client'

import env from '../config/env'
import prisma from '../lib/prisma'
import { writeAuditLog } from './audit.service'
import { resolveCouponForCheckout, recordCouponRedemption } from './coupon.service'
import { getDeliveryEtaMinutes } from './delivery-eta.service'
import { awardLoyaltyPointsForOrder } from './loyalty.service'
import { getAuthoritativeCheckoutSnapshot } from './public-storefront.service'
import { sendPushToCustomer } from './push-notification.service'
import {
  cancelSalesOrderInInventory,
  getInventorySalesOrderStatus,
  pushSalesOrderToInventory,
} from './inventory-client.service'
import { createHttpError } from '../utils/httpError'
import { haversineDistanceKm } from '../utils/geo'
import { mapOrder } from '../utils/serializers'
import { getShopTodayStatus } from '../utils/shop-availability'
import { normalizeOptionalString } from '../utils/user'
import type { CheckoutPayloadInput } from '../validation/orders.validation'

interface CreateOrderOptions {
  customerUserId: string
}

interface OrderAccessContext {
  userId: string
  role: UserRole
  shopOwnerProfileId?: string | null
}

/**
 * Service-area gating: rejects checkout when the delivery location is
 * farther from the shop than its configured service radius.
 *
 * Decisions on missing data (documented for the task write-up):
 *  - Shop has no latitude/longitude set: the check is skipped entirely —
 *    there is nothing to measure against, and blocking every order for
 *    shops that haven't set coordinates yet would be worse than a no-op.
 *  - Shop has coordinates but `serviceRadiusKm` is null: falls back to
 *    `DEFAULT_SERVICE_RADIUS_KM` (env, default 10km) rather than skipping —
 *    a shop with known coordinates should still get *some* hyperlocal
 *    bound, not an unlimited one, even before they've explicitly set a
 *    radius.
 *  - Customer location unknown (no saved address coordinates and no ad-hoc
 *    lat/lng in the payload): the check is skipped — we have no coordinate
 *    to compare against. This is a known gap until the frontend's Google
 *    Maps address flow (see location.routes.ts) makes lat/lng mandatory on
 *    every address.
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

/**
 * NearCart-Inventory `SalesOrderStatus` -> NearCart `OrderStatus` mapping.
 *
 *   DRAFT / PENDING     -> PENDING_CONFIRMATION
 *   CONFIRMED           -> ACCEPTED
 *   READY               -> READY_FOR_PICKUP
 *   OUT_FOR_DELIVERY    -> OUT_FOR_DELIVERY
 *   DELIVERED           -> DELIVERED
 *   REJECTED            -> REJECTED
 *   CANCELLED           -> CANCELLED
 *   RETURNED            -> DELIVERED (NearCart's OrderStatus enum has no
 *                          post-delivery "returned" state; DELIVERED is the
 *                          closest terminal state. Revisit if returns need
 *                          their own customer-facing status later.)
 *
 * Unknown/unrecognized values fall back to `null` (no local status change)
 * rather than guessing, so an unexpected value from the bridge never
 * silently corrupts local order state.
 */
function mapInventorySalesOrderStatus(
  inventoryStatus: string,
): OrderStatus | null {
  switch (inventoryStatus) {
    case 'DRAFT':
    case 'PENDING':
      return 'PENDING_CONFIRMATION'
    case 'CONFIRMED':
      return 'ACCEPTED'
    case 'READY':
      return 'READY_FOR_PICKUP'
    case 'OUT_FOR_DELIVERY':
      return 'OUT_FOR_DELIVERY'
    case 'DELIVERED':
    case 'RETURNED':
      return 'DELIVERED'
    case 'REJECTED':
      return 'REJECTED'
    case 'CANCELLED':
      return 'CANCELLED'
    default:
      return null
  }
}

async function createOrderNumber(
  transaction: Prisma.TransactionClient,
  placedAt: Date,
): Promise<string> {
  const datePrefix = placedAt.toISOString().slice(0, 10).replaceAll('-', '')
  const dayStart = new Date(placedAt)
  dayStart.setUTCHours(0, 0, 0, 0)

  const dayEnd = new Date(placedAt)
  dayEnd.setUTCHours(23, 59, 59, 999)

  const existingOrdersCount = await transaction.order.count({
    where: {
      createdAt: {
        gte: dayStart,
        lte: dayEnd,
      },
    },
  })

  return `NC-${datePrefix}-${String(existingOrdersCount + 1).padStart(4, '0')}`
}

async function resolveCustomerAddress(
  customerUserId: string,
  addressId: string | null,
) {
  if (!addressId) {
    return null
  }

  const address = await prisma.address.findFirst({
    where: {
      id: addressId,
      userId: customerUserId,
    },
  })

  if (!address) {
    throw createHttpError(404, 'Saved address not found')
  }

  return address
}

/**
 * Bug found via live end-to-end testing 2026-07-27: `CheckoutPage.tsx`'s "verify your email
 * before ordering" gate is UI-only — a curl'd `POST /orders` with a valid access token from an
 * unverified account went through to a real, inventory-synced order, 201 Created, no server-side
 * check anywhere in this function. Client-side gates are a UX nicety, never the actual
 * enforcement boundary; this closes that gap at the one place that actually matters.
 */
async function assertCustomerIsVerified(customerUserId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: customerUserId },
    select: { isVerified: true },
  })

  if (!user?.isVerified) {
    throw createHttpError(
      403,
      'Please verify your email before placing an order.',
      { code: 'EMAIL_NOT_VERIFIED' },
    )
  }
}

/**
 * Blocks checkout unless the shop owner has explicitly confirmed their shop is open TODAY (see
 * `src/utils/shop-availability.ts`). A shop that's never said anything today, or said so on a
 * previous day, reads as "PENDING_CONFIRMATION" — customers must not be able to place orders a
 * shop hasn't actually committed to fulfilling.
 */
function assertShopIsOpenToday(
  shop: Pick<Shop, 'name' | 'isOpenToday' | 'todayStatusReason' | 'todayStatusUpdatedAt'>,
): void {
  const todayStatus = getShopTodayStatus(shop)

  if (todayStatus === 'OPEN') {
    return
  }

  const message =
    todayStatus === 'PENDING_CONFIRMATION'
      ? "This shop hasn't confirmed today's availability yet — check back soon."
      : `This shop is closed today${shop.todayStatusReason ? ` (${shop.todayStatusReason})` : ''}`

  throw createHttpError(403, message, {
    code: 'SHOP_NOT_OPEN_TODAY',
    data: { todayStatus, reason: shop.todayStatusReason ?? null },
  })
}

async function createOrder(
  payload: CheckoutPayloadInput,
  options: CreateOrderOptions,
) {
  await assertCustomerIsVerified(options.customerUserId)

  const placedAt = new Date()
  const customerAddress = await resolveCustomerAddress(
    options.customerUserId,
    normalizeOptionalString(payload.addressId),
  )
  const checkoutSnapshot = await getAuthoritativeCheckoutSnapshot({
    shopId: payload.shopId,
    items: payload.items,
  })
  const { shop } = checkoutSnapshot

  assertShopIsOpenToday(shop)

  if (
    shop.minimumOrderAmount > 0 &&
    checkoutSnapshot.summary.subtotal < shop.minimumOrderAmount
  ) {
    throw createHttpError(
      400,
      `Minimum order amount for ${shop.name} is ${shop.minimumOrderAmount}.`,
      {
        minimumOrderAmount: shop.minimumOrderAmount,
        subtotal: checkoutSnapshot.summary.subtotal,
      },
    )
  }

  const effectiveLatitude = customerAddress?.latitude ?? payload.latitude ?? null
  const effectiveLongitude =
    customerAddress?.longitude ?? payload.longitude ?? null

  assertWithinServiceArea(shop, effectiveLatitude, effectiveLongitude)

  const normalizedCouponCode = normalizeOptionalString(payload.couponCode)

  const createdOrder = await prisma.$transaction(async (transaction) => {
    const orderNumber = await createOrderNumber(transaction, placedAt)

    // Coupon resolution happens inside this same transaction, before the order row exists —
    // `resolveCouponForCheckout` only validates + computes the discount (it can't create the
    // `CouponRedemption` yet, since that has a required unique `orderId` FK). See
    // `recordCouponRedemption` below, called once the order row is created.
    let discountAmount = 0
    let resolvedCoupon: Awaited<ReturnType<typeof resolveCouponForCheckout>>['coupon'] | null = null

    if (normalizedCouponCode) {
      const resolution = await resolveCouponForCheckout(transaction, {
        userId: options.customerUserId,
        code: normalizedCouponCode,
        subtotal: checkoutSnapshot.summary.subtotal,
        preDiscountTotal: checkoutSnapshot.summary.totalAmount,
      })
      discountAmount = resolution.discountAmount
      resolvedCoupon = resolution.coupon
    }

    const order = await transaction.order.create({
      data: {
        orderNumber,
        customerUserId: options.customerUserId,
        shopId: shop.slug,
        shopRecordId: shop.id,
        shopName: shop.name,
        status: 'PENDING_CONFIRMATION',
        paymentStatus: 'PENDING',
        customerName: payload.customerName.trim(),
        customerPhone: payload.customerPhone.trim(),
        customerEmail: normalizeOptionalString(payload.customerEmail),
        deliveryAddressId: customerAddress?.id ?? null,
        deliveryAddressLabel: customerAddress?.label ?? null,
        deliveryAddressLine1:
          customerAddress?.line1 ?? payload.deliveryAddressLine1.trim(),
        deliveryAddressLine2:
          customerAddress?.line2 ??
          normalizeOptionalString(payload.deliveryAddressLine2),
        city: customerAddress?.city ?? payload.city.trim(),
        area: customerAddress?.area ?? normalizeOptionalString(payload.area),
        pincode: customerAddress?.pincode ?? payload.pincode.trim(),
        landmark:
          customerAddress?.landmark ?? normalizeOptionalString(payload.landmark),
        latitude: effectiveLatitude,
        longitude: effectiveLongitude,
        notes: normalizeOptionalString(payload.notes),
        paymentMethod: payload.paymentMethod,
        subtotal: checkoutSnapshot.summary.subtotal,
        deliveryFee: checkoutSnapshot.summary.deliveryFee,
        weatherSurchargeFee: checkoutSnapshot.summary.weatherSurchargeFee,
        weatherCondition: checkoutSnapshot.summary.weatherCondition,
        platformFee: 0,
        couponCode: resolvedCoupon?.code ?? null,
        discountAmount,
        totalAmount: checkoutSnapshot.summary.totalAmount - discountAmount,
        createdAt: placedAt,
        placedAt,
        items: {
          create: checkoutSnapshot.appliedItems.map((item) => ({
            storeProductId: item.productId,
            inventoryProductId: item.productId,
            inventoryVariantId: item.variantId ?? null,
            name: item.name ?? 'Catalog item',
            brand: item.brand?.name ?? null,
            size: item.unitLabel ?? null,
            unitLabel: item.unitLabel ?? null,
            image: item.image ?? null,
            price: item.price ?? 0,
            mrp: item.mrp ?? null,
            quantity: item.quantity,
            lineTotal: (item.price ?? 0) * item.quantity,
          })),
        },
      },
      include: {
        items: true,
      },
    })

    if (resolvedCoupon) {
      await recordCouponRedemption(transaction, {
        couponId: resolvedCoupon.id,
        userId: options.customerUserId,
        orderId: order.id,
        discountAmount,
      })
    }

    return order
  })

  await writeAuditLog({
    actorId: options.customerUserId,
    actorType: 'CUSTOMER',
    action: 'ORDER_CREATE',
    entityType: 'Order',
    entityId: createdOrder.id,
    before: null,
    after: {
      status: createdOrder.status,
      orderNumber: createdOrder.orderNumber,
      shopId: createdOrder.shopId,
      totalAmount: createdOrder.totalAmount,
    },
  })

  const orderWithSyncState = await syncOrderToInventoryBridge(
    createdOrder,
    shop,
  )

  return mapOrder(orderWithSyncState)
}

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>
type OrderWithRelations = Prisma.OrderGetPayload<{
  include: { items: true; shop: true; review: true }
}>

/**
 * Pushes a just-created Order into the NearCart-Inventory marketplace
 * bridge as a `SalesOrder` (source=APP). Failures here are logged and
 * recorded on the order (`inventorySyncStatus: 'FAILED'`) but never thrown
 * — a customer's order must exist locally regardless of whether the shop's
 * back-office system could be reached at that instant. The `FAILED` flag is
 * what a retry job (not implemented here) would poll for.
 */
async function syncOrderToInventoryBridge(
  createdOrder: OrderWithItems,
  shop: Pick<Shop, 'inventoryOrganizationId' | 'inventoryBranchId'>,
): Promise<OrderWithItems> {
  if (!shop.inventoryOrganizationId || !shop.inventoryBranchId) {
    // Should not happen in practice — checkout requires a mapped shop (see
    // `getMappedPublicShop`) — but guarded defensively in case that
    // invariant ever changes.
    return createdOrder
  }

  try {
    const result = await pushSalesOrderToInventory({
      organizationId: shop.inventoryOrganizationId,
      branchId: shop.inventoryBranchId,
      externalOrderId: createdOrder.id,
      externalOrderNumber: createdOrder.orderNumber,
      customer: {
        name: createdOrder.customerName,
        phone: createdOrder.customerPhone,
        addressLine: createdOrder.deliveryAddressLine1,
        latitude: createdOrder.latitude,
        longitude: createdOrder.longitude,
      },
      items: createdOrder.items.map((item) => ({
        inventoryProductId: item.inventoryProductId ?? item.storeProductId,
        inventoryVariantId: item.inventoryVariantId ?? null,
        quantity: item.quantity,
        unitPrice: item.price,
      })),
      notes: createdOrder.notes ?? undefined,
    })

    return await prisma.order.update({
      where: { id: createdOrder.id },
      data: {
        inventorySalesOrderId: result.salesOrderId,
        inventorySalesOrderNumber: result.orderNumber,
        inventorySyncStatus: 'SYNCED',
        inventorySyncError: null,
        inventoryLastSyncedAt: new Date(),
      },
      include: { items: true },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    console.error(
      `[NearKart] Failed to push order ${createdOrder.orderNumber} into the inventory bridge (order was still created locally):`,
      message,
    )

    return prisma.order.update({
      where: { id: createdOrder.id },
      data: {
        inventorySyncStatus: 'FAILED',
        inventorySyncError: message.slice(0, 500),
        inventoryLastSyncedAt: new Date(),
      },
      include: { items: true },
    })
  }
}

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  'DELIVERED',
  'REJECTED',
  'CANCELLED',
])

/**
 * Called on `GET /orders/:orderId` — if this order was bridged into
 * NearCart-Inventory, polls its current SalesOrder status and applies any
 * change locally (see `mapInventorySalesOrderStatus` for the mapping).
 * Never throws: a sync hiccup should degrade to "show the last known local
 * status" rather than fail the customer's order-detail view.
 */
async function refreshOrderStatusFromInventory(
  order: OrderWithRelations,
): Promise<OrderWithRelations> {
  if (!order.inventorySalesOrderId || TERMINAL_ORDER_STATUSES.has(order.status)) {
    return order
  }

  try {
    const bridgeStatus = await getInventorySalesOrderStatus(order.id)
    const mappedStatus = mapInventorySalesOrderStatus(bridgeStatus.status)

    if (!mappedStatus || mappedStatus === order.status) {
      return order
    }

    const updateData: Prisma.OrderUpdateInput = {
      status: mappedStatus,
      inventorySyncStatus: 'SYNCED',
      inventorySyncError: null,
      inventoryLastSyncedAt: new Date(),
    }

    if (mappedStatus === 'ACCEPTED' && !order.acceptedAt) {
      updateData.acceptedAt = bridgeStatus.confirmedAt
        ? new Date(bridgeStatus.confirmedAt)
        : new Date()
    }

    if (mappedStatus === 'DELIVERED' && !order.deliveredAt) {
      updateData.deliveredAt = bridgeStatus.deliveredAt
        ? new Date(bridgeStatus.deliveredAt)
        : new Date()
    }

    // Cash/pay-on-pickup orders are settled the moment the driver hands over the goods — there's
    // no separate "mark paid" step anywhere in this codebase (confirmed by grep: nothing else
    // ever writes PaymentStatus.PAID), so without this every COD order stays PENDING forever, even
    // after delivery. ONLINE is deliberately left untouched: there's no payment-gateway
    // integration here to confirm money actually moved, so PENDING is the honest state for it.
    if (
      mappedStatus === 'DELIVERED' &&
      order.paymentStatus === 'PENDING' &&
      (order.paymentMethod === 'COD' || order.paymentMethod === 'PAY_ON_PICKUP')
    ) {
      updateData.paymentStatus = 'PAID'
    }

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: updateData,
      include: { items: true, shop: true, review: true },
    })

    if (mappedStatus === 'DELIVERED') {
      await awardLoyaltyPointsForOrder(updatedOrder)
    }

    return updatedOrder
  } catch (error) {
    console.warn(
      `[NearKart] Failed to refresh order ${order.orderNumber} status from the inventory bridge:`,
      error instanceof Error ? error.message : error,
    )

    return order
  }
}

/**
 * Shared ownership check for both `getOrderById` and `cancelOrder` — an
 * ADMIN can access any order, a CUSTOMER only their own, a SHOP_OWNER only
 * orders placed at a shop they own. Returns 404 (not 403) on a denied
 * access the same way the original `getOrderById` did, so this never
 * reveals that an order id exists to someone who shouldn't see it.
 */
function assertOrderAccessible(
  order: OrderWithRelations,
  accessContext: OrderAccessContext,
): void {
  const canAccessOrder =
    accessContext.role === 'ADMIN' ||
    (accessContext.role === 'CUSTOMER' &&
      order.customerUserId === accessContext.userId) ||
    (accessContext.role === 'SHOP_OWNER' &&
      Boolean(accessContext.shopOwnerProfileId) &&
      order.shop?.ownerProfileId === accessContext.shopOwnerProfileId)

  if (!canAccessOrder) {
    throw createHttpError(404, 'Order not found')
  }
}

const ACTIVE_TRACKING_STATUSES = new Set<OrderStatus>([
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
])

/**
 * Adds a `tracking` block to a single order's detail response — the shop's own coordinates
 * (never exposed by `mapOrder` itself, which only carries the *delivery* lat/lng) plus a live
 * ETA figure, so the mobile order-tracking screen has everything it needs for a map + countdown
 * in one call instead of stitching together a separate shop lookup.
 *
 * There is no live driver GPS signal available to this backend (NearCart-Inventory tracks
 * `Driver.lastKnownLatitude/longitude` but does not expose it over the marketplace bridge — see
 * `driverName`/etc. on `Order` for what *is* available) — `tracking.shop` +
 * `tracking.deliveryEtaMinutes` is what the frontend uses to render an estimated, interpolated
 * position instead of a real one. Only computed for orders in an active, trackable state
 * (accepted through out-for-delivery); pending/terminal orders get `tracking: null` since there's
 * nothing useful to show on a map yet (shop hasn't confirmed) or ever again (delivered/cancelled/
 * rejected).
 */
async function buildOrderTracking(order: OrderWithRelations) {
  if (!ACTIVE_TRACKING_STATUSES.has(order.status) || !order.shop) {
    return null
  }

  const { shop } = order

  let etaMinutes: number | null = null
  try {
    const eta = await getDeliveryEtaMinutes({
      shop,
      customerLatitude: order.latitude,
      customerLongitude: order.longitude,
      mode: 'full',
    })
    etaMinutes = eta.etaMinutes
  } catch (error) {
    console.warn(
      `[NearKart] Failed to compute live ETA for order ${order.orderNumber} tracking view:`,
      error instanceof Error ? error.message : error,
    )
  }

  return {
    shop: {
      id: shop.id,
      name: shop.name,
      phone: shop.phone,
      latitude: shop.latitude,
      longitude: shop.longitude,
    },
    deliveryEtaMinutes: etaMinutes,
  }
}

async function getOrderById(orderId: string, accessContext: OrderAccessContext) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      shop: true,
      review: true,
    },
  })

  if (!order) {
    throw createHttpError(404, 'Order not found')
  }

  assertOrderAccessible(order, accessContext)

  const refreshedOrder = await refreshOrderStatusFromInventory(order)
  const tracking = await buildOrderTracking(refreshedOrder)

  return { ...mapOrder(refreshedOrder), tracking }
}

/**
 * Customer-initiated order cancellation. Locked business rule: only
 * allowed while `status === 'PENDING_CONFIRMATION'` — once a shop has
 * acted on an order (accepted/rejected/etc.) it's too late to cancel
 * through this endpoint, and any other status (including an
 * already-terminal one) is a 409.
 *
 * On success: flips the local status to `CANCELLED`, then — only if the
 * order was actually bridged into Inventory (`inventorySyncStatus ===
 * 'SYNCED'` and it has an `inventorySalesOrderId`; a `FAILED`/
 * `NOT_APPLICABLE` sync means there's nothing to cancel on that side) —
 * calls `cancelSalesOrderInInventory`. That bridge call's failure is
 * logged and reflected back onto `inventorySyncStatus`/`inventorySyncError`
 * (mirroring `syncOrderToInventoryBridge`'s convention) so the desync is
 * visible in the order-detail response and in logs, but it never blocks
 * the local cancel from succeeding — a customer cancelling their own order
 * must not be held hostage by a flaky bridge call.
 */
async function cancelOrder(orderId: string, accessContext: OrderAccessContext) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      shop: true,
      review: true,
    },
  })

  if (!order) {
    throw createHttpError(404, 'Order not found')
  }

  assertOrderAccessible(order, accessContext)

  if (order.status !== 'PENDING_CONFIRMATION') {
    // The old message hardcoded "it has already been accepted by the shop" for every non-
    // cancellable status, including CANCELLED/REJECTED/DELIVERED — actively misleading for e.g. a
    // customer double-tapping cancel on an order that was already cancelled or rejected.
    const reason: Record<string, string> = {
      CANCELLED: 'it has already been cancelled.',
      REJECTED: 'the shop has already rejected it.',
      DELIVERED: 'it has already been delivered.',
    }

    throw createHttpError(
      409,
      `Order can no longer be cancelled — ${
        reason[order.status] ?? 'it has already been accepted by the shop.'
      }`,
    )
  }

  const beforeSnapshot = { status: order.status }

  let finalOrder = await prisma.order.update({
    where: { id: order.id },
    data: { status: 'CANCELLED' },
    include: { items: true, shop: true, review: true },
  })

  const shouldCancelInInventory =
    order.inventorySyncStatus === 'SYNCED' &&
    Boolean(order.inventorySalesOrderId) &&
    Boolean(order.shop?.inventoryOrganizationId)

  if (shouldCancelInInventory) {
    try {
      await cancelSalesOrderInInventory({
        organizationId: order.shop!.inventoryOrganizationId!,
        externalOrderId: order.id,
      })

      finalOrder = await prisma.order.update({
        where: { id: order.id },
        data: {
          inventorySyncStatus: 'SYNCED',
          inventorySyncError: null,
          inventoryLastSyncedAt: new Date(),
        },
        include: { items: true, shop: true, review: true },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'

      console.error(
        `[NearKart] Order ${order.orderNumber} was cancelled locally, but cancelling the linked SalesOrder in the inventory bridge failed (now desynced — the shop's Inventory dashboard will not reflect this cancellation until reconciled):`,
        message,
      )

      finalOrder = await prisma.order.update({
        where: { id: order.id },
        data: {
          inventorySyncStatus: 'FAILED',
          inventorySyncError: `Cancel was not reflected in inventory: ${message}`.slice(0, 500),
          inventoryLastSyncedAt: new Date(),
        },
        include: { items: true, shop: true, review: true },
      })
    }
  }

  await writeAuditLog({
    actorId: accessContext.userId,
    actorType: accessContext.role,
    action: 'ORDER_CANCEL',
    entityType: 'Order',
    entityId: order.id,
    before: beforeSnapshot,
    after: { status: finalOrder.status },
  })

  return mapOrder(finalOrder)
}

interface InventoryOrderEventInput {
  externalOrderId: string
  status: string
  eventType:
    | 'CONFIRMED'
    | 'REJECTED'
    | 'READY'
    | 'DRIVER_ASSIGNED'
    | 'DRIVER_UNASSIGNED'
    | 'OUT_FOR_DELIVERY'
    | 'DELIVERED'
    | 'AUTO_CANCELLED'
    | 'CANCELLED'
  assignedDriver?: { fullName: string; phone: string; vehicleType: string } | null
}

const ORDER_EVENT_NOTIFICATION_COPY: Record<
  InventoryOrderEventInput['eventType'],
  { title: string; body: string }
> = {
  CONFIRMED: { title: 'Order confirmed', body: 'Your order has been confirmed by the shop.' },
  REJECTED: { title: 'Order declined', body: 'The shop was unable to accept your order.' },
  READY: { title: 'Order ready', body: 'Your order is ready and awaiting a delivery partner.' },
  DRIVER_ASSIGNED: {
    title: 'Delivery partner assigned',
    body: 'A delivery partner has been assigned to your order.',
  },
  DRIVER_UNASSIGNED: {
    title: 'Finding a new delivery partner',
    body: 'Your previous delivery partner is no longer available — we are finding a new one for your order.',
  },
  OUT_FOR_DELIVERY: {
    title: 'Out for delivery',
    body: 'Your order is on its way!',
  },
  DELIVERED: { title: 'Order delivered', body: 'Your order has been delivered. Enjoy!' },
  AUTO_CANCELLED: {
    title: 'Order cancelled',
    body: 'The shop did not confirm your order in time, so it was automatically cancelled.',
  },
  CANCELLED: {
    title: 'Order cancelled',
    body: 'The shop has cancelled your order.',
  },
}

/**
 * Receiver side of the reverse notification webhook (see middleware/internalService.ts +
 * routes/internal.routes.ts) — NearCart-Inventory calls this whenever a bridged SalesOrder
 * (source: APP) changes status, since the customer/device-token relationship lives here, not
 * there. Replaces the old poll-only refreshOrderStatusFromInventory as the primary way
 * Order.status advances for bridged orders; that function stays in place as a fallback for
 * orders whose webhook call was missed (network blip, etc).
 */
async function applyInventoryOrderEvent(input: InventoryOrderEventInput): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: input.externalOrderId } })

  if (!order) {
    return
  }

  // Guard against a duplicate/out-of-order webhook call regressing an order that has already
  // reached a terminal state — e.g. a delayed CONFIRMED event arriving after a faster
  // AUTO_CANCELLED/DELIVERED call already landed. Once terminal, nothing coming through this
  // webhook should move the order (or notify the customer about it) again.
  if (TERMINAL_ORDER_STATUSES.has(order.status)) {
    return
  }

  const mappedStatus = mapInventorySalesOrderStatus(input.status)

  if (mappedStatus && mappedStatus !== order.status) {
    const updateData: Prisma.OrderUpdateInput = {
      status: mappedStatus,
      inventorySyncStatus: 'SYNCED',
      inventorySyncError: null,
      inventoryLastSyncedAt: new Date(),
    }

    if (mappedStatus === 'ACCEPTED' && !order.acceptedAt) {
      updateData.acceptedAt = new Date()
    }

    if (mappedStatus === 'DELIVERED' && !order.deliveredAt) {
      updateData.deliveredAt = new Date()
    }

    // See the matching comment in refreshOrderStatusFromInventory — COD/PAY_ON_PICKUP orders are
    // settled at handover and nothing else in this codebase ever writes PaymentStatus.PAID.
    if (
      mappedStatus === 'DELIVERED' &&
      order.paymentStatus === 'PENDING' &&
      (order.paymentMethod === 'COD' || order.paymentMethod === 'PAY_ON_PICKUP')
    ) {
      updateData.paymentStatus = 'PAID'
    }

    // Persist the assigned driver's identity/contact fields the first time this webhook fires
    // for this order — previously `input.assignedDriver` was only read to build the push
    // notification body below and then discarded, so an order-detail fetch could never show who
    // was delivering it. Written once (not re-written on later events for the same order) since
    // a driver reassignment mid-delivery isn't a case this webhook's `eventType` enum models.
    if (input.eventType === 'DRIVER_ASSIGNED' && input.assignedDriver) {
      updateData.driverName = input.assignedDriver.fullName
      updateData.driverPhone = input.assignedDriver.phone
      updateData.driverVehicleType = input.assignedDriver.vehicleType
      updateData.driverAssignedAt = new Date()
    }

    await prisma.order.update({ where: { id: order.id }, data: updateData })

    if (mappedStatus === 'DELIVERED') {
      await awardLoyaltyPointsForOrder(order)
    }
  } else if (input.eventType === 'DRIVER_ASSIGNED' && input.assignedDriver) {
    // DRIVER_ASSIGNED doesn't map to a NearCart OrderStatus change on its own (mappedStatus is
    // null for it — see `mapInventorySalesOrderStatus`), so the branch above never runs for this
    // event type. Still needs its own write so the driver fields land at all.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        driverName: input.assignedDriver.fullName,
        driverPhone: input.assignedDriver.phone,
        driverVehicleType: input.assignedDriver.vehicleType,
        driverAssignedAt: new Date(),
      },
    })
  } else if (input.eventType === 'DRIVER_UNASSIGNED') {
    // Fired when a driver declines an order and no replacement is immediately found (see
    // NearCart-Inventory's declineDriverOrder). Before this branch existed, nothing ever told
    // NearCart about an unassignment — a customer would keep seeing the declining driver's stale
    // name/phone on their order (a real "who's bringing my order" trust problem) until either a
    // new driver happened to get assigned later or the order reached a terminal state. Clearing
    // these here is the honest state: no driver is currently assigned.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        driverName: null,
        driverPhone: null,
        driverVehicleType: null,
        driverAssignedAt: null,
      },
    })
  }

  // `customerUserId` is nullable (SetNull if the owning User is ever deleted) — there's no
  // device to notify in that case, but the status update above must still happen regardless.
  // Previously this whole function bailed out before the status update whenever
  // `customerUserId` was null, silently dropping the order out of sync with Inventory forever.
  if (!order.customerUserId) {
    return
  }

  const copy = ORDER_EVENT_NOTIFICATION_COPY[input.eventType]
  const body =
    input.eventType === 'DRIVER_ASSIGNED' && input.assignedDriver
      ? `${input.assignedDriver.fullName} (${input.assignedDriver.vehicleType}) has been assigned to your order.`
      : copy.body

  await sendPushToCustomer(order.customerUserId, {
    title: copy.title,
    body,
    data: { orderId: order.id, eventType: input.eventType },
    channelId: 'order_alert',
  })
}

export { applyInventoryOrderEvent, cancelOrder, createOrder, getOrderById }
