import { Prisma } from '@prisma/client'
import type { OrderStatus, Shop, UserRole } from '@prisma/client'

import prisma from '../lib/prisma'
import { kvDel, kvSetNx } from '../lib/kvStore'
import { writeAuditLog } from './audit.service'
import { resolveCouponForCheckout, recordCouponRedemption } from './coupon.service'
import { getDeliveryEtaMinutes } from './delivery-eta.service'
import {
  awardLoyaltyPointsForOrder,
  getLoyaltyRedemptionForOrder,
  recordLoyaltyRedemption,
  resolveLoyaltyRedemptionForCheckout,
} from './loyalty.service'
import { getAuthoritativeCheckoutSnapshot } from './public-storefront.service'
import { sendPushToCustomer } from './push-notification.service'
import {
  cancelSalesOrderInInventory,
  getInventorySalesOrderStatus,
  pushSalesOrderToInventory,
} from './inventory-client.service'
import type { PushSalesOrderPayment } from './inventory-client.service'
import { createHttpError } from '../utils/httpError'
import { assertWithinServiceArea } from '../utils/geo'
import { mapOrder } from '../utils/serializers'
import { assertShopIsOpenToday } from '../utils/shop-availability'
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

/**
 * Critical bug found via live adversarial testing 2026-08-08: this used to compute the next
 * sequence number as `COUNT(today's orders) + 1`. That's only correct as long as the sequence
 * has zero gaps — and a gap is exactly what the order-number race below (see
 * `isOrderNumberConflict`'s doc comment) produces the moment a losing transaction's number gets
 * "spent" without a row ever landing for it (the losing attempt's computed number was never
 * inserted, but once ANY other transaction goes on to claim a higher number, the count of rows
 * permanently undercounts relative to the highest number actually in use). Once that happens,
 * `COUNT + 1` recomputes the SAME already-taken number on every subsequent attempt forever —
 * confirmed live: after a handful of concurrent test checkouts produced one such gap, EVERY
 * following checkout attempt failed with the exact same `UNIQUE constraint failed:
 * Order.orderNumber` error, including purely sequential, non-concurrent ones, because the count
 * never moves even though the true highest order number keeps climbing. This wasn't a rare edge
 * case — it reproduced on the very first bit of concurrent checkout traffic and then wedged
 * checkout for the rest of the day.
 *
 * Fix: derive the next number from `MAX(today's order numbers) + 1` instead of a count. This is
 * self-healing regardless of how many gaps already exist — it always continues from the true
 * highest number in use, so a gap can never cause a permanent collision again. (True same-instant
 * collisions between two transactions computing the same "next" number at once can still happen
 * — that's what `createOrderTransactionWithRetry`'s retry-with-backoff above is for — but that's
 * now a genuine one-off race, not a self-reinforcing stuck state.)
 */
async function createOrderNumber(
  transaction: Prisma.TransactionClient,
  placedAt: Date,
): Promise<string> {
  const datePrefix = placedAt.toISOString().slice(0, 10).replaceAll('-', '')
  const orderNumberPrefix = `NC-${datePrefix}-`

  const todaysOrders = await transaction.order.findMany({
    where: {
      orderNumber: {
        startsWith: orderNumberPrefix,
      },
    },
    select: {
      orderNumber: true,
    },
  })

  const highestSequence = todaysOrders.reduce((max, { orderNumber }) => {
    const suffix = Number.parseInt(orderNumber.slice(orderNumberPrefix.length), 10)
    return Number.isFinite(suffix) && suffix > max ? suffix : max
  }, 0)

  return `${orderNumberPrefix}${String(highestSequence + 1).padStart(4, '0')}`
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

// `assertShopIsOpenToday` moved to `../utils/shop-availability.ts` (imported above) so both
// this file's `createOrder` and `public-storefront.service.ts`'s `validatePublicCart` can share
// one implementation without a circular import between the two service modules — see that
// file's doc comment for the full rationale. Behavior is unchanged, only the location moved.

const MAX_ORDER_NUMBER_ATTEMPTS = 8

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Bug found via live testing 2026-08-08 alongside the `isOrderNumberConflict` detection gap
 * above: even once conflicts are correctly detected, firing 4+ genuinely concurrent checkouts
 * (different customers, same shop, same instant) made EVERY one of them exhaust all retry
 * attempts and still fail — confirmed by instrumenting the retry loop live. Root cause: retrying
 * immediately with no delay keeps the competing requests in lockstep. Each round, all of them
 * recount at roughly the same moment (similar network latency to the DB), so a loser from round 1
 * doesn't just risk re-colliding with the original winner — it can just as easily re-collide with
 * one of the OTHER losers, who read the exact same stale count it did. Nothing about immediate
 * retry breaks that symmetry, so a big enough herd can stay synchronized for every attempt.
 * Full-jitter backoff (a random delay, capped and growing with attempt number, before recounting)
 * is the standard fix for exactly this shape of problem — it de-synchronizes the herd so
 * transactions naturally spread out across the retry window instead of re-bunching every round.
 */
function orderNumberRetryBackoffMs(attempt: number): number {
  const capMs = Math.min(25 * 2 ** (attempt - 1), 400)
  return Math.floor(Math.random() * capMs)
}

/**
 * `createOrderNumber` picks the next order number by counting today's existing orders, then
 * this same transaction inserts a row using that number — a classic count-then-insert race.
 * `Order.orderNumber` is `@unique` in the schema, so two checkouts landing in the same window
 * (ordinary concurrent traffic, not a rare corner case) can both count N existing orders, both
 * compute "...-000{N+1}", and one of the two transactions fails with a unique-constraint
 * violation that — left unhandled — surfaces as an opaque 500 to a customer whose order was
 * otherwise perfectly valid. Detects exactly that conflict (and only that one, not any other
 * unique-constraint failure the transaction might legitimately raise, e.g. a coupon race) so it
 * can be retried.
 */
/**
 * Bug found via live concurrent-checkout testing 2026-08-08: two customers racing this exact
 * order-number window produced a raw, unhandled `DriverAdapterError` (from
 * `@prisma/driver-adapter-utils`, thrown by `@prisma/adapter-libsql`) that surfaced straight to
 * the client as a 500 with the literal SQLite message ("SQLITE_CONSTRAINT: ... UNIQUE constraint
 * failed: Order.orderNumber") — for an order that was otherwise perfectly valid, exactly the
 * failure mode this whole retry mechanism exists to prevent. The `PrismaClientKnownRequestError`
 * / P2002 shape this function originally only checked for is what a unique-constraint violation
 * looks like when Prisma's error-translation layer gets to wrap it; empirically (confirmed via
 * the server log while reproducing this), a violation raised *inside* an interactive
 * `$transaction()` callback on this Prisma 7 + adapter-libsql combination sometimes bypasses that
 * translation entirely and comes through as the driver adapter's own untranslated error class
 * instead. Rather than importing `@prisma/driver-adapter-utils` just for an `instanceof` check
 * (an indirect dependency, not declared in this app's own package.json), this matches on the
 * error's own message text — which is present on both shapes and is the one part of this that's
 * stable across however Prisma chooses to wrap/not-wrap the underlying driver error next.
 */
function isOrderNumberUniqueConstraintMessage(message: string): boolean {
  return /unique constraint failed/i.test(message) && message.includes('orderNumber')
}

function isOrderNumberConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    // Prisma's P2002 `meta` shape is adapter-dependent, confirmed by triggering a real duplicate
    // insert against this app's actual `@prisma/adapter-libsql` setup while verifying this fix:
    // the field list is NOT under `meta.target` here (that's the vanilla-driver shape) — it's
    // nested under `meta.driverAdapterError.cause.constraint.fields`. Checking `target` alone
    // would silently never match on this adapter and this whole retry-on-conflict fix would be a
    // no-op. Both shapes are checked so this keeps working if the adapter/driver ever changes.
    const meta = error.meta as
      | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
      | undefined

    const targetFields = Array.isArray(meta?.target) ? (meta?.target as unknown[]) : []
    const driverAdapterFields = Array.isArray(meta?.driverAdapterError?.cause?.constraint?.fields)
      ? (meta?.driverAdapterError?.cause?.constraint?.fields as unknown[])
      : []

    if ([...targetFields, ...driverAdapterFields].includes('orderNumber')) {
      return true
    }

    if (typeof error.message === 'string' && isOrderNumberUniqueConstraintMessage(error.message)) {
      return true
    }

    return false
  }

  // Fallback for the raw (untranslated) driver-adapter error shape described above — walk the
  // error's own message and, defensively, one level of `cause` (in case a future Prisma version
  // wraps it differently again), matching on text rather than a specific error class.
  if (error instanceof Error) {
    if (isOrderNumberUniqueConstraintMessage(error.message)) {
      return true
    }

    const cause = (error as { cause?: unknown }).cause

    if (
      cause &&
      typeof cause === 'object' &&
      'message' in cause &&
      typeof (cause as { message: unknown }).message === 'string' &&
      isOrderNumberUniqueConstraintMessage((cause as { message: string }).message)
    ) {
      return true
    }
  }

  return false
}

/**
 * Runs `createOrder`'s transaction, retrying from scratch (fresh order-number count included)
 * whenever it fails solely because of the order-number race described above. Safe to retry
 * blindly on that one conflict — nothing inside the transaction is committed until it succeeds,
 * so every side effect (coupon resolution, item rows) is cleanly redone. Any other error
 * (validation failure, coupon conflict, genuine DB problem) is rethrown immediately without
 * retrying.
 */
async function createOrderTransactionWithRetry(
  run: (transaction: Prisma.TransactionClient) => Promise<OrderWithItems>,
): Promise<OrderWithItems> {
  for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(run)
    } catch (error) {
      if (isOrderNumberConflict(error) && attempt < MAX_ORDER_NUMBER_ATTEMPTS) {
        await sleep(orderNumberRetryBackoffMs(attempt))
        continue
      }

      throw error
    }
  }

  // Unreachable: the loop above always either returns or throws.
  throw new Error('Failed to create order after exhausting order-number retry attempts')
}

const CHECKOUT_LOCK_TTL_SECONDS = 15

function checkoutLockKey(customerUserId: string): string {
  return `checkout-lock:${customerUserId}`
}

/**
 * Bug found via live adversarial testing 2026-08-08: firing two `POST /orders` requests back to
 * back for the same customer (a fast double-tap on "place order" before the frontend's
 * `isSubmitting` guard disables the button, a flaky client retry, or simply two browser tabs)
 * created two separate, fully inventory-synced orders — confirmed with real concurrent curl
 * requests, both returned 201 with distinct order numbers. There was no server-side guard against
 * this at all; the frontend's disabled-button state is a UX nicety, not the enforcement boundary
 * (same lesson as `assertCustomerIsVerified`'s doc comment above).
 *
 * This is a short-lived mutual-exclusion lock, not a payload-based idempotency key (the client
 * sends no idempotency key today, and adding one is a bigger frontend+backend change) — while
 * held, any other checkout attempt from the same customer is rejected outright rather than
 * silently deduped, so the customer sees a clear "still processing" message instead of a
 * confusingly-ignored second click. `kvSetNx` (see its doc comment) is what makes this safe under
 * true concurrency, the same way `recordCouponRedemption`'s conditional `updateMany` is for the
 * coupon-usage race — a plain get-then-set here would have the identical TOCTOU gap this is meant
 * to close. TTL is a crash-safety net (in case a request dies between acquiring the lock and the
 * `finally` release below), not the primary release mechanism.
 */
async function createOrder(
  payload: CheckoutPayloadInput,
  options: CreateOrderOptions,
) {
  const lockAcquired = await kvSetNx(
    checkoutLockKey(options.customerUserId),
    '1',
    CHECKOUT_LOCK_TTL_SECONDS,
  )

  if (!lockAcquired) {
    throw createHttpError(
      409,
      "Your previous order is still being placed. Please wait a moment — check your orders before trying again.",
      { code: 'CHECKOUT_IN_PROGRESS' },
    )
  }

  try {
    return await createOrderLocked(payload, options)
  } finally {
    await kvDel(checkoutLockKey(options.customerUserId))
  }
}

async function createOrderLocked(
  payload: CheckoutPayloadInput,
  options: CreateOrderOptions,
) {
  await assertCustomerIsVerified(options.customerUserId)

  const placedAt = new Date()
  const customerAddress = await resolveCustomerAddress(
    options.customerUserId,
    normalizeOptionalString(payload.addressId),
  )

  // Resolved before `getAuthoritativeCheckoutSnapshot` (not after, as before) so checkout's
  // delivery-fee distance calculation runs on the literal same coordinates as
  // `POST /public/cart/validate` — a second, divergent resolution here previously left checkout
  // silently unable to compute a distance-based fee even after cart-preview could. See the
  // 2026-08-09 price-drift bug fix for why single-sourcing this matters.
  const effectiveLatitude = customerAddress?.latitude ?? payload.latitude ?? null
  const effectiveLongitude =
    customerAddress?.longitude ?? payload.longitude ?? null

  const checkoutSnapshot = await getAuthoritativeCheckoutSnapshot({
    shopId: payload.shopId,
    items: payload.items,
    latitude: effectiveLatitude,
    longitude: effectiveLongitude,
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

  assertWithinServiceArea(shop, effectiveLatitude, effectiveLongitude)

  const normalizedCouponCode = normalizeOptionalString(payload.couponCode)

  const createdOrder = await createOrderTransactionWithRetry(async (transaction) => {
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

    // New feature: loyalty-points redemption, resolved the same two-step way as the coupon
    // above it (resolve against a pre-order snapshot here, record against the real order once it
    // exists — see `recordLoyaltyRedemption` below). Stacks with a coupon rather than being
    // mutually exclusive with one; `resolveLoyaltyRedemptionForCheckout` clamps to whatever's
    // actually usable (balance + per-order cap) rather than erroring, so this is always safe to
    // call even when the request is stale or the customer has no points at all (resolves to 0).
    const loyaltyResolution = await resolveLoyaltyRedemptionForCheckout(transaction, {
      customerUserId: options.customerUserId,
      requestedPoints: payload.useLoyaltyPoints ?? 0,
      subtotal: checkoutSnapshot.summary.subtotal,
    })
    const loyaltyDiscountAmount = loyaltyResolution.discountAmount

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
        // Combined coupon + loyalty-points discount — `Order` has no separate column for the
        // loyalty portion (avoids a schema change for this), but it stays fully attributable via
        // the `LoyaltyLedgerEntry` row `recordLoyaltyRedemption` writes below (queried back out by
        // `getLoyaltyRedemptionForOrder` for the order-detail view / this response).
        discountAmount: discountAmount + loyaltyDiscountAmount,
        totalAmount: Math.max(
          0,
          checkoutSnapshot.summary.totalAmount - discountAmount - loyaltyDiscountAmount,
        ),
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
        usageLimit: resolvedCoupon.usageLimit,
      })
    }

    if (loyaltyResolution.pointsToRedeem > 0) {
      await recordLoyaltyRedemption(transaction, {
        customerUserId: options.customerUserId,
        orderId: order.id,
        pointsToRedeem: loyaltyResolution.pointsToRedeem,
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

  const loyaltyRedemption = await getLoyaltyRedemptionForOrder(createdOrder.id)

  return { ...mapOrder(orderWithSyncState), loyaltyRedemption }
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
/**
 * The money facts pushed to NearCart-Inventory alongside a SalesOrder (`payment` on the bridge
 * payload). Inventory's own `SalesOrder.total` is goods value only, so this block is the ONLY way
 * the shop (Partner app) and the driver learn what the customer actually owes — before it existed
 * a 360 + 74 delivery fee COD order told the driver to collect 360, and an order's payment method
 * never reached either app at all. Every amount is whole rupees straight off the `Order` row (its
 * money columns are `Int` rupees, the same unit as the `items[].unitPrice` sent next to this), so
 * the figures here are byte-identical to what the customer saw at checkout:
 *   amountPayable (= Order.totalAmount)
 *     = itemTotal + deliveryFee + weatherSurchargeFee + platformFee - discountTotal, floored at 0.
 * `platformFee` has no line of its own in the contract, so it is folded into `deliveryFee` to keep
 * that identity true for the shop's bill summary (it is always 0 today — see `createOrder`).
 * Exported for tests.
 */
function buildInventoryPaymentPayload(
  order: Pick<
    OrderWithItems,
    | 'paymentMethod'
    | 'paymentStatus'
    | 'subtotal'
    | 'deliveryFee'
    | 'weatherSurchargeFee'
    | 'platformFee'
    | 'discountAmount'
    | 'couponCode'
    | 'totalAmount'
  >,
  loyaltyDiscount?: number | null,
): PushSalesOrderPayment {
  return {
    method: order.paymentMethod,
    status: order.paymentStatus,
    itemTotal: order.subtotal,
    deliveryFee: order.deliveryFee + order.platformFee,
    ...(order.weatherSurchargeFee > 0
      ? { weatherSurchargeFee: order.weatherSurchargeFee }
      : {}),
    discountTotal: order.discountAmount,
    ...(loyaltyDiscount && loyaltyDiscount > 0 ? { loyaltyDiscount } : {}),
    ...(order.couponCode ? { couponCode: order.couponCode } : {}),
    amountPayable: order.totalAmount,
    currency: 'INR',
  }
}

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

  // Loyalty-points portion of `Order.discountAmount` (there is no column for it — see
  // `createOrder`), purely informational for the shop's bill summary. Looked up here rather than
  // passed in so the retry sweep (`reconcileFailedInventorySyncs`), which only has the Order row,
  // sends exactly the same payload as the checkout-time push. Never allowed to fail the push: the
  // amount the driver collects (`amountPayable`) doesn't depend on it.
  let loyaltyDiscount: number | null = null

  try {
    loyaltyDiscount =
      (await getLoyaltyRedemptionForOrder(createdOrder.id))?.discountAmount ?? null
  } catch (error) {
    console.warn(
      `[NearKart] Could not read the loyalty redemption for order ${createdOrder.orderNumber} — pushing its payment block without the loyalty breakdown`,
      error,
    )
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
      payment: buildInventoryPaymentPayload(createdOrder, loyaltyDiscount),
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

/**
 * Periodic reconciliation for orders whose bridge sync previously failed and was never retried
 * (see `syncOrderToInventoryBridge` above, and `cancelOrder`'s inventory-side cancel-push
 * failure path below) — both intentionally never throw, so a flaky/unreachable Inventory backend
 * can never break a customer's checkout or cancel, but that resilience used to come at the cost
 * of silently orphaning the order forever: nothing ever revisited `inventorySyncStatus: 'FAILED'`.
 * Concretely, without this:
 *   - A checkout-time push failure meant no SalesOrder was ever created on the Inventory side, so
 *     the shop's own confirmation-deadline auto-cancel sweep could never find it either (there's
 *     no row for it to match) — the order would sit at PENDING_CONFIRMATION forever unless the
 *     customer happened to notice and self-cancel.
 *   - A cancel-time push failure meant the customer's order showed CANCELLED locally while the
 *     shop's Inventory dashboard kept showing it as still open indefinitely.
 * Exported as a plain function (mirroring NearCart-Inventory's order-confirmation-sweep pattern)
 * so it can be invoked directly outside the schedule (manual runs, tests) as well as from the
 * registered cron in jobs/inventory-sync-retry-sweep.ts.
 */
async function reconcileFailedInventorySyncs(): Promise<{
  pushed: number
  pushFailed: number
  cancelled: number
  cancelFailed: number
}> {
  let pushed = 0
  let pushFailed = 0
  let cancelled = 0
  let cancelFailed = 0

  // Case A: the initial checkout-time push never succeeded — no SalesOrder exists on the
  // Inventory side yet. Scoped to `status: 'PENDING_CONFIRMATION'` specifically: if the customer
  // has since cancelled locally (nothing else can move a never-synced order out of
  // PENDING_CONFIRMATION), pushing it now would create a SalesOrder for an order the customer no
  // longer wants — the cancel-retry branch below is what should run for that case instead.
  let pendingPushRetries: Array<OrderWithItems & { shop: Shop | null }>

  try {
    pendingPushRetries = await prisma.order.findMany({
      where: {
        inventorySyncStatus: 'FAILED',
        inventorySalesOrderId: null,
        status: 'PENDING_CONFIRMATION',
      },
      include: { items: true, shop: true },
    })
  } catch (error) {
    // A DB error here must never crash the process — this job runs unattended on a schedule,
    // forever (same reasoning as NearCart-Inventory's order-confirmation-sweep).
    console.warn(
      '[NearKart] [inventory-sync-retry] Failed to query orders pending an initial-push retry — skipping this tick',
      error,
    )
    pendingPushRetries = []
  }

  for (const order of pendingPushRetries) {
    if (!order.shop) {
      continue
    }

    try {
      const result = await syncOrderToInventoryBridge(order, order.shop)

      if (result.inventorySyncStatus === 'SYNCED') {
        pushed += 1
      } else {
        pushFailed += 1
      }
    } catch (error) {
      // syncOrderToInventoryBridge already catches its own failures internally and never throws
      // — this is defense in depth only, matching the same posture as Inventory's sweep.
      pushFailed += 1
      console.warn(
        `[NearKart] [inventory-sync-retry] Unexpected error retrying push for order ${order.orderNumber}`,
        error,
      )
    }
  }

  // Case B: the order was cancelled locally, but the matching cancel on the Inventory-side
  // SalesOrder failed and was never retried — the shop's dashboard is left showing a still-open
  // order the customer believes (and NearCart shows) is cancelled.
  let cancelRetries: Array<OrderWithItems & { shop: Shop | null }>

  try {
    cancelRetries = await prisma.order.findMany({
      where: {
        inventorySyncStatus: 'FAILED',
        status: 'CANCELLED',
        inventorySalesOrderId: { not: null },
      },
      include: { items: true, shop: true },
    })
  } catch (error) {
    console.warn(
      '[NearKart] [inventory-sync-retry] Failed to query orders pending a cancel retry — skipping this tick',
      error,
    )
    cancelRetries = []
  }

  for (const order of cancelRetries) {
    if (!order.shop?.inventoryOrganizationId) {
      continue
    }

    try {
      await cancelSalesOrderInInventory({
        organizationId: order.shop.inventoryOrganizationId,
        externalOrderId: order.id,
      })

      await prisma.order.update({
        where: { id: order.id },
        data: {
          inventorySyncStatus: 'SYNCED',
          inventorySyncError: null,
          inventoryLastSyncedAt: new Date(),
        },
      })

      cancelled += 1
    } catch (error) {
      // A 409 here (already terminal on the Inventory side — e.g. staff separately delivered it
      // before the cancel landed) is a legitimate permanent desync, not a transient failure, but
      // it will still be retried on the next tick regardless of cause. That's an acceptable
      // tradeoff for a periodic best-effort reconciler with no retry-count/backoff state to
      // persist (a schema change is deliberately avoided here — Prisma migrate/db push are known
      // broken against this project's libsql:// connection) — the desync stays visible via
      // `inventorySyncError` either way, for a human to investigate if it never clears.
      const message = error instanceof Error ? error.message : 'Unknown error'

      cancelFailed += 1

      await prisma.order
        .update({
          where: { id: order.id },
          data: {
            inventorySyncError: `Cancel retry failed: ${message}`.slice(0, 500),
            inventoryLastSyncedAt: new Date(),
          },
        })
        .catch((updateError) => {
          console.warn(
            `[NearKart] [inventory-sync-retry] Failed to record cancel-retry failure for order ${order.orderNumber}`,
            updateError,
          )
        })

      console.warn(
        `[NearKart] [inventory-sync-retry] Retry of inventory cancel failed for order ${order.orderNumber}`,
        message,
      )
    }
  }

  if (pushed || pushFailed || cancelled || cancelFailed) {
    console.log(
      `[NearKart] [inventory-sync-retry] push: ${pushed} succeeded / ${pushFailed} still failing; cancel: ${cancelled} succeeded / ${cancelFailed} still failing.`,
    )
  }

  return { pushed, pushFailed, cancelled, cancelFailed }
}

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  'DELIVERED',
  'REJECTED',
  'CANCELLED',
])

/**
 * Ordinal position of each non-terminal status in the happy-path lifecycle. Used by
 * `isForwardOrderStatusTransition` to make status writes monotonic — see that function for why.
 * Terminal statuses (DELIVERED/REJECTED/CANCELLED) are deliberately absent: they're always a
 * legitimate destination regardless of rank (see below), and both callers already refuse to
 * touch an order whose *current* status is terminal (`TERMINAL_ORDER_STATUSES` checks at the top
 * of each function), so this map is never consulted to decide whether to *leave* one.
 */
const ORDER_STATUS_RANK: Partial<Record<OrderStatus, number>> = {
  PENDING_CONFIRMATION: 0,
  ACCEPTED: 1,
  PREPARING: 2,
  READY_FOR_PICKUP: 3,
  OUT_FOR_DELIVERY: 4,
}

/**
 * Bridged orders are advanced from two independent, racing sources: a GET-time poll
 * (`refreshOrderStatusFromInventory`) and a push webhook (`applyInventoryOrderEvent`), both
 * reading/reacting to the same underlying Inventory-side SalesOrder. When they disagree — a
 * stale poll read landing after a faster webhook already advanced the order, a retried webhook,
 * replication lag — the loser must not be allowed to regress `status` backwards, because status
 * writes also set stage-specific timestamp fields (`acceptedAt`/`deliveredAt`) that are never
 * cleared on a later write. Applying a stale "PENDING" read after a genuine "CONFIRMED" webhook
 * had already landed used to revert `status` to PENDING_CONFIRMATION while leaving `acceptedAt`
 * populated — an inconsistent `{status:"PENDING_CONFIRMATION", acceptedAt:"<timestamp>"}` row.
 *
 * Fix: only forward movement (or a move into a terminal state, which always wins) is ever
 * applied; a disagreeing read that would move status backwards is treated as stale and dropped.
 * This is also the right behavior independent of the timestamp issue — the Inventory-side
 * SalesOrder is the source of truth and its status only moves forward too, so a "backwards" read
 * here is by construction a stale one, not a legitimate un-confirm.
 */
function isForwardOrderStatusTransition(current: OrderStatus, next: OrderStatus): boolean {
  if (current === next) {
    return false
  }

  if (!(next in ORDER_STATUS_RANK)) {
    // `next` is terminal (DELIVERED/REJECTED/CANCELLED) — always a legitimate destination.
    return true
  }

  const currentRank = ORDER_STATUS_RANK[current]
  const nextRank = ORDER_STATUS_RANK[next]

  if (currentRank === undefined || nextRank === undefined) {
    // `current` is terminal, which can't happen here (both callers bail out before reaching this
    // check whenever `current` is terminal) — fall back to "not forward" rather than throwing if
    // that invariant is ever violated elsewhere.
    return false
  }

  return nextRank > currentRank
}

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
    const hasForwardStatusMove =
      Boolean(mappedStatus) && isForwardOrderStatusTransition(order.status, mappedStatus!)

    const updateData: Prisma.OrderUpdateInput = {}

    if (hasForwardStatusMove) {
      updateData.status = mappedStatus!
      updateData.inventorySyncStatus = 'SYNCED'
      updateData.inventorySyncError = null
      updateData.inventoryLastSyncedAt = new Date()

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

      // Delivery-proof photo, if the bridge response carries one — defensive read, since the
      // sibling NearCart-Inventory repo's poll-status endpoint may not send this field yet (it's
      // being added there separately). Only ever set when a value is actually present, so an
      // older/not-yet-updated bridge response never overwrites an already-stored photo with
      // nothing.
      if (bridgeStatus.deliveryProofPhotoUrl) {
        updateData.deliveryProofPhotoUrl = bridgeStatus.deliveryProofPhotoUrl
      }

      // Cash/pay-on-pickup orders are settled the moment the driver hands over the goods —
      // there's no separate "mark paid" step anywhere in this codebase (confirmed by grep:
      // nothing else ever writes PaymentStatus.PAID), so without this every COD order stays
      // PENDING forever, even after delivery. ONLINE is deliberately left untouched: there's no
      // payment-gateway integration here to confirm money actually moved, so PENDING is the
      // honest state for it.
      if (
        mappedStatus === 'DELIVERED' &&
        order.paymentStatus === 'PENDING' &&
        (order.paymentMethod === 'COD' || order.paymentMethod === 'PAY_ON_PICKUP')
      ) {
        updateData.paymentStatus = 'PAID'
      }
    }

    // Assigned-driver identity/contact — deliberately evaluated independently of
    // `hasForwardStatusMove` above. Driver (re)assignment does not always coincide with a status
    // change (e.g. a decline-and-reassign while the order stays READY), and this poll is the only
    // fallback for driver info at all — the DRIVER_ASSIGNED/DRIVER_UNASSIGNED push webhook
    // (`applyInventoryOrderEvent`) is fire-and-forget with no retry on the Inventory side, so a
    // dropped webhook used to mean the customer's driver fields never updated (or never cleared)
    // for the rest of that delivery, full stop — polling couldn't help because the field wasn't
    // even in the response. `bridgeStatus.assignedDriver === undefined` means an older bridge
    // deployment that doesn't select this relation yet — no signal either way, existing fields
    // are left untouched.
    if (bridgeStatus.assignedDriver !== undefined) {
      if (bridgeStatus.assignedDriver) {
        const driverInfoChanged =
          order.driverName !== bridgeStatus.assignedDriver.fullName ||
          order.driverPhone !== bridgeStatus.assignedDriver.phone ||
          order.driverVehicleType !== bridgeStatus.assignedDriver.vehicleType

        if (driverInfoChanged) {
          updateData.driverName = bridgeStatus.assignedDriver.fullName
          updateData.driverPhone = bridgeStatus.assignedDriver.phone
          updateData.driverVehicleType = bridgeStatus.assignedDriver.vehicleType

          if (!order.driverAssignedAt) {
            updateData.driverAssignedAt = bridgeStatus.driverAssignedAt
              ? new Date(bridgeStatus.driverAssignedAt)
              : new Date()
          }
        }
      } else if (order.driverName || order.driverPhone || order.driverVehicleType || order.driverAssignedAt) {
        // The bridge explicitly reports no driver currently assigned (e.g. a decline with no
        // immediate replacement) — clear stale identity/contact info rather than leaving the
        // customer looking at a driver who is no longer delivering their order.
        updateData.driverName = null
        updateData.driverPhone = null
        updateData.driverVehicleType = null
        updateData.driverAssignedAt = null
      }
    }

    if (Object.keys(updateData).length === 0) {
      return order
    }

    // A successful poll that only changed driver fields (no forward status move) still counts as
    // a successful sync — record it the same way the status-move branch above does, so
    // `inventoryLastSyncedAt`/`inventorySyncStatus` stay meaningful regardless of which fields
    // actually changed.
    if (!hasForwardStatusMove) {
      updateData.inventorySyncStatus = 'SYNCED'
      updateData.inventorySyncError = null
      updateData.inventoryLastSyncedAt = new Date()
    }

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: updateData,
      include: { items: true, shop: true, review: true },
    })

    if (mappedStatus === 'DELIVERED' && hasForwardStatusMove) {
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
  const loyaltyRedemption = await getLoyaltyRedemptionForOrder(refreshedOrder.id)

  return { ...mapOrder(refreshedOrder), tracking, loyaltyRedemption }
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

  // Reconcile against the Inventory-side SalesOrder before deciding whether this order is still
  // cancellable. The local `status` column is only advanced by the (fire-and-forget, no-retry)
  // reverse webhook or by a customer's own GET /orders/:orderId poll — without this, a customer
  // could race a shop's just-issued confirm (webhook not yet landed / customer hasn't repolled)
  // and force-cancel an order the shop already committed to and deducted stock for.
  // `refreshOrderStatusFromInventory` never throws and only ever moves `status` forward, so this
  // is safe to call unconditionally here.
  const reconciledOrder = await refreshOrderStatusFromInventory(order)

  if (reconciledOrder.status !== 'PENDING_CONFIRMATION') {
    // The old message hardcoded "it has already been accepted by the shop" for every non-
    // cancellable status, including CANCELLED/REJECTED/DELIVERED/OUT_FOR_DELIVERY — actively
    // misleading for e.g. a customer double-tapping cancel on an order that was already
    // cancelled/rejected, or trying to cancel one that's already out for delivery. Every status
    // in `OrderStatus` that reaches this branch (i.e. anything other than
    // `PENDING_CONFIRMATION`) is covered explicitly; the fallback still derives a message from
    // the order's actual current status rather than a fixed phrase, so any future enum value
    // added here degrades gracefully instead of silently going back to a wrong hardcoded string.
    const reason: Record<string, string> = {
      CANCELLED: 'it has already been cancelled.',
      REJECTED: 'the shop has already rejected it.',
      DELIVERED: 'it has already been delivered.',
      ACCEPTED: 'it has already been accepted by the shop.',
      PREPARING: 'the shop has already started preparing it.',
      READY_FOR_PICKUP: 'it is already ready for pickup.',
      OUT_FOR_DELIVERY: 'it has already been picked up for delivery.',
    }

    throw createHttpError(
      409,
      `Order can no longer be cancelled — ${
        reason[reconciledOrder.status] ??
        `it is already ${reconciledOrder.status.replace(/_/g, ' ').toLowerCase()}.`
      }`,
    )
  }

  const beforeSnapshot = { status: reconciledOrder.status }

  let finalOrder = await prisma.order.update({
    where: { id: reconciledOrder.id },
    data: { status: 'CANCELLED' },
    include: { items: true, shop: true, review: true },
  })

  const shouldCancelInInventory =
    reconciledOrder.inventorySyncStatus === 'SYNCED' &&
    Boolean(reconciledOrder.inventorySalesOrderId) &&
    Boolean(reconciledOrder.shop?.inventoryOrganizationId)

  if (shouldCancelInInventory) {
    try {
      await cancelSalesOrderInInventory({
        organizationId: reconciledOrder.shop!.inventoryOrganizationId!,
        externalOrderId: reconciledOrder.id,
      })

      finalOrder = await prisma.order.update({
        where: { id: reconciledOrder.id },
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
        `[NearKart] Order ${reconciledOrder.orderNumber} was cancelled locally, but cancelling the linked SalesOrder in the inventory bridge failed (now desynced — the shop's Inventory dashboard will not reflect this cancellation until reconciled):`,
        message,
      )

      finalOrder = await prisma.order.update({
        where: { id: reconciledOrder.id },
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
  // Delivery-proof photo (Cloudinary URL), present on a DELIVERED event once the sibling
  // NearCart-Inventory repo sends it. Optional — see `orderEventSchema` in
  // `internal.controller.ts`.
  deliveryProofPhotoUrl?: string | null
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

  if (mappedStatus && isForwardOrderStatusTransition(order.status, mappedStatus)) {
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

    // Delivery-proof photo, when the DELIVERED event carries one. Optional field — see
    // `InventoryOrderEventInput` — so an event without it (older sibling-repo deploy, or a
    // driver who didn't capture a photo) simply leaves this untouched rather than nulling out
    // anything already stored.
    if (mappedStatus === 'DELIVERED' && input.deliveryProofPhotoUrl) {
      updateData.deliveryProofPhotoUrl = input.deliveryProofPhotoUrl
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

export {
  applyInventoryOrderEvent,
  buildInventoryPaymentPayload,
  cancelOrder,
  createOrder,
  getOrderById,
  reconcileFailedInventorySyncs,
}
