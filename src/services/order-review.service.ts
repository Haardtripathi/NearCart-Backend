import prisma from '../lib/prisma'
import { writeAuditLog } from './audit.service'
import { createHttpError } from '../utils/httpError'
import { normalizeOptionalString } from '../utils/user'
import type { CreateOrderReviewInput, ShopReviewsQueryInput } from '../validation/order-review.validation'

interface CreateOrderReviewOptions {
  orderId: string
  customerUserId: string
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

  const review = await prisma.orderReview.create({
    data: {
      orderId: order.id,
      customerId: options.customerUserId,
      shopId: order.shopRecordId,
      rating: payload.rating,
      comment: normalizeOptionalString(payload.comment),
    },
  })

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

/**
 * Shared by `getPublicShop`/`listPublicShopCatalog`/`getPublicCatalogProduct`
 * (public-storefront.service.ts) to attach the average-rating + review-count
 * pair onto a shop detail response. A simple grouped `_avg`/`_count`
 * aggregate — no caching, no materialized column — is plenty at this scale;
 * revisit only if a shop-detail page load is ever shown to be aggregate-
 * query-bound in practice.
 */
async function getShopRatingSummary(shopRecordId: string) {
  const aggregate = await prisma.orderReview.aggregate({
    where: { shopId: shopRecordId },
    _avg: { rating: true },
    _count: { rating: true },
  })

  return {
    averageRating: aggregate._avg.rating ?? null,
    reviewCount: aggregate._count.rating,
  }
}

export { createOrderReview, getShopRatingSummary, listShopReviews }
