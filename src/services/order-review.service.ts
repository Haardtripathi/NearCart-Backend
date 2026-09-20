import { Prisma } from '@prisma/client'

import prisma from '../lib/prisma'
import {
  bumpShopDirectoryGeneration,
  getCachedJson,
  shopDirectoryCacheKey,
} from '../lib/cache'
import { writeAuditLog } from './audit.service'
import { createHttpError } from '../utils/httpError'
import { normalizeOptionalString } from '../utils/user'
import type { CreateOrderReviewInput, ShopReviewsQueryInput } from '../validation/order-review.validation'

interface CreateOrderReviewOptions {
  orderId: string
  customerUserId: string
}

/**
 * Detects a `OrderReview.orderId` unique-constraint violation specifically (not any other P2002
 * this create could theoretically raise). Mirrors `orders.service.ts`'s `isOrderNumberConflict`
 * exactly, including checking both possible `meta` shapes — confirmed there, on this app's actual
 * `@prisma/adapter-libsql` setup, that the violated-field list is sometimes NOT under the
 * standard `meta.target` array but nested under `meta.driverAdapterError.cause.constraint.fields`
 * instead, so relying on `target` alone would silently never match here.
 */
function isOrderReviewUniqueConstraintConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false
  }

  const meta = error.meta as
    | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
    | undefined

  const targetFields = Array.isArray(meta?.target) ? (meta?.target as unknown[]) : []
  const driverAdapterFields = Array.isArray(meta?.driverAdapterError?.cause?.constraint?.fields)
    ? (meta?.driverAdapterError?.cause?.constraint?.fields as unknown[])
    : []

  if ([...targetFields, ...driverAdapterFields].includes('orderId')) {
    return true
  }

  return typeof error.message === 'string' && /unique constraint failed/i.test(error.message) && error.message.includes('orderId')
}

function mapOrderReview(review: {
  id: string
  orderId: string
  customerId: string
  shopId: string
  rating: number
  comment: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: review.id,
    orderId: review.orderId,
    customerId: review.customerId,
    shopId: review.shopId,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  }
}

/**
 * Public, name-only reviewer shape for `GET /public/shops/:shopId/reviews` —
 * never leaks the reviewing customer's email/phone, just a display name.
 */
function mapPublicOrderReview(review: {
  id: string
  rating: number
  comment: string | null
  createdAt: Date
  customer: { fullName: string }
}) {
  return {
    id: review.id,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt,
    reviewerName: review.customer.fullName,
  }
}

/**
 * Creates a review for a DELIVERED order owned by the requesting customer.
 * Locked business rules (mirroring `cancelOrder`'s style of guard clauses in
 * `orders.service.ts`):
 *  - 404 if the order doesn't exist or isn't this customer's (never reveals
 *    existence of another customer's order, same convention as
 *    `assertOrderAccessible`).
 *  - 409 if the order hasn't reached `DELIVERED` yet — nothing to review.
 *  - 409 if a review already exists for this order (the DB's
 *    `@unique(orderId)` constraint is the real backstop; this check exists
 *    to return a clean, actionable 409 instead of a raw constraint-violation
 *    500).
 */
async function createOrderReview(
  payload: CreateOrderReviewInput,
  options: CreateOrderReviewOptions,
) {
  const order = await prisma.order.findUnique({
    where: { id: options.orderId },
    include: { review: true },
  })

  if (!order || order.customerUserId !== options.customerUserId) {
    throw createHttpError(404, 'Order not found')
  }

  if (order.status !== 'DELIVERED') {
    throw createHttpError(
      409,
      'You can only review an order once it has been delivered.',
    )
  }

  if (order.review) {
    throw createHttpError(409, 'This order has already been reviewed.')
  }

  if (!order.shopRecordId) {
    // Should not happen in practice — checkout requires a mapped shop (see
    // `getMappedPublicShop`/`createOrder`) — but guarded defensively since
    // `Order.shopRecordId` is nullable in the schema (`onDelete: SetNull`).
    throw createHttpError(
      409,
      'This order is no longer linked to a shop and cannot be reviewed.',
    )
  }

  // Adversarial sweep finding: `order.review` above is a plain read-then-check — two concurrent
  // `POST /orders/:orderId/review` calls for the same order (a double-tap before the submit
  // button disables, or a client retry racing its own original request) can both pass that check
  // before either commits, then both attempt this `create()`. `OrderReview.orderId` is `@unique`
  // (see the doc comment above this function), so the DB itself correctly rejects the second
  // write — but left uncaught here, that surfaces as a raw Prisma `P2002` unique-constraint
  // exception, which `errorHandler.ts` treats as an unknown error (masked to a generic 500 in
  // production) rather than the clean, actionable 409 the exact same "already reviewed" case
  // gets one line up when it loses the read-then-check race instead of the write race. Catching
  // it here and mapping to the same 409 makes both racing requests behave identically regardless
  // of which one actually wins the DB write.
  let review
  try {
    review = await prisma.orderReview.create({
      data: {
        orderId: order.id,
        customerId: options.customerUserId,
        shopId: order.shopRecordId,
        rating: payload.rating,
        comment: normalizeOptionalString(payload.comment),
      },
    })
  } catch (error) {
    if (isOrderReviewUniqueConstraintConflict(error)) {
      throw createHttpError(409, 'This order has already been reviewed.')
    }

    throw error
  }

  // This shop's cached rating aggregate is now wrong.
  bumpShopDirectoryGeneration()

  await writeAuditLog({
    actorId: options.customerUserId,
    actorType: 'CUSTOMER',
    action: 'ORDER_REVIEW_CREATE',
    entityType: 'OrderReview',
    entityId: review.id,
    before: null,
    after: { orderId: review.orderId, shopId: review.shopId, rating: review.rating },
  })

  return mapOrderReview(review)
}

async function listShopReviews(shopId: string, query: ShopReviewsQueryInput) {
  const shop = await prisma.shop.findFirst({
    where: { OR: [{ id: shopId }, { slug: shopId }] },
    select: { id: true },
  })

  if (!shop) {
    throw createHttpError(404, 'Shop not found')
  }

  const page = query.page ?? 1
  const limit = query.limit ?? 10

  const [reviews, total, aggregate] = await Promise.all([
    prisma.orderReview.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { customer: { select: { fullName: true } } },
    }),
    prisma.orderReview.count({ where: { shopId: shop.id } }),
    prisma.orderReview.aggregate({
      where: { shopId: shop.id },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ])

  return {
    items: reviews.map(mapPublicOrderReview),
    meta: {
      page,
      limit,
      totalItems: total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      averageRating: aggregate._avg.rating ?? null,
      reviewCount: aggregate._count.rating,
    },
  }
}

interface ShopRatingSummary {
  averageRating: number | null
  reviewCount: number
}

// A shop's average moves only when someone reviews it, and reviews are rare writes against a
// slowly growing table — so this is cached rather than re-aggregated on every shop-detail,
// catalog and product-detail render. `createOrderReview` drops the cached entry, so the
// instance that took the review is immediately consistent.
const SHOP_RATING_CACHE_TTL_SECONDS = 300

/**
 * Shared by `getPublicShop`/`listPublicShopCatalog`/`getPublicCatalogProduct`
 * (public-storefront.service.ts) to attach the average-rating + review-count
 * pair onto a shop detail response.
 */
async function getShopRatingSummary(shopRecordId: string): Promise<ShopRatingSummary> {
  return getCachedJson(
    shopDirectoryCacheKey('shop-rating', shopRecordId),
    SHOP_RATING_CACHE_TTL_SECONDS,
    async () => {
      const aggregate = await prisma.orderReview.aggregate({
        where: { shopId: shopRecordId },
        _avg: { rating: true },
        _count: { rating: true },
      })

      return {
        averageRating: aggregate._avg.rating ?? null,
        reviewCount: aggregate._count.rating,
      }
    },
  )
}

/**
 * The same aggregate for many shops at once, in ONE grouped query instead of one per shop —
 * what a list of shop cards (favourites) needs. Shops with no reviews yet are simply absent from
 * the grouped result, so callers fall back to the empty summary rather than expecting a row.
 */
async function getShopRatingSummaries(
  shopRecordIds: string[],
): Promise<Map<string, ShopRatingSummary>> {
  const summaries = new Map<string, ShopRatingSummary>()
  const uniqueIds = [...new Set(shopRecordIds)]

  if (uniqueIds.length === 0) {
    return summaries
  }

  const grouped = await prisma.orderReview.groupBy({
    by: ['shopId'],
    where: { shopId: { in: uniqueIds } },
    _avg: { rating: true },
    _count: { rating: true },
  })

  for (const row of grouped) {
    summaries.set(row.shopId, {
      averageRating: row._avg.rating ?? null,
      reviewCount: row._count.rating,
    })
  }

  return summaries
}

export { createOrderReview, getShopRatingSummaries, getShopRatingSummary, listShopReviews }
export type { ShopRatingSummary }
