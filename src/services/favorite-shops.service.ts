import prisma from '../lib/prisma'
import { buildMeta } from '../utils/response'
import { createHttpError } from '../utils/httpError'
import { getShopRatingSummary } from './order-review.service'
import { attachLiveEta, mapPublicShopSummary } from './public-storefront.service'

/**
 * Simple shop bookmark for a customer — no rating/comment attached (OrderReview already covers
 * that). Checked before building this: grepped the whole schema for Favorite/Wishlist/Bookmark,
 * nothing existed.
 *
 * Shop objects are built the same way `listPublicShops` builds them (`mapPublicShopSummary` +
 * `attachLiveEta` in 'fast' mode, plus the rating aggregate) rather than the internal
 * `mapShop` shape — the mobile app's Favorites screen renders these through the exact same
 * `PublicShopSummary`-shaped card as the home/search screens, so the response needs to match
 * that public shape (isOpenNow/liveEstimatedDeliveryMinutes/deliveryFee/...), not the
 * shop-owner-facing admin shape `mapShop` returns.
 */
async function listFavoriteShops(userId: string) {
  const favorites = await prisma.favoriteShop.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { shop: true },
  })

  const items = await Promise.all(
    favorites.map(async (favorite) => {
      const [rating, summaryWithEta] = await Promise.all([
        getShopRatingSummary(favorite.shop.id),
        attachLiveEta(favorite.shop, mapPublicShopSummary(favorite.shop), null, 'fast'),
      ])

      return {
        favoritedAt: favorite.createdAt,
        shop: {
          ...summaryWithEta,
          averageRating: rating.averageRating,
          reviewCount: rating.reviewCount,
        },
      }
    }),
  )

  return {
    items,
    meta: buildMeta({ total: items.length }),
  }
}

/** Also returns the current favorite shop ids alone (cheap, no shop join) — used by screens that
 *  already have shop cards loaded from elsewhere (home/search) and just need to know which ones
 *  to render as "favorited" without re-fetching full shop objects. */
async function listFavoriteShopIds(userId: string) {
  const favorites = await prisma.favoriteShop.findMany({
    where: { userId },
    select: { shopId: true },
  })

  return {
    item: { shopIds: favorites.map((favorite) => favorite.shopId) },
    meta: buildMeta(),
  }
}

async function addFavoriteShop(userId: string, shopIdOrSlug: string) {
  const shop = await prisma.shop.findFirst({
    where: { OR: [{ id: shopIdOrSlug }, { slug: shopIdOrSlug }] },
    select: { id: true },
  })

  if (!shop) {
    throw createHttpError(404, 'Shop not found')
  }

  await prisma.favoriteShop.upsert({
    where: { userId_shopId: { userId, shopId: shop.id } },
    update: {},
    create: { userId, shopId: shop.id },
  })

  return {
    item: { shopId: shop.id, isFavorite: true },
    meta: buildMeta(),
  }
}

async function removeFavoriteShop(userId: string, shopIdOrSlug: string) {
  const shop = await prisma.shop.findFirst({
    where: { OR: [{ id: shopIdOrSlug }, { slug: shopIdOrSlug }] },
    select: { id: true },
  })

  if (!shop) {
    throw createHttpError(404, 'Shop not found')
  }

  await prisma.favoriteShop.deleteMany({ where: { userId, shopId: shop.id } })

  return {
    item: { shopId: shop.id, isFavorite: false },
    meta: buildMeta(),
  }
}

export { addFavoriteShop, listFavoriteShopIds, listFavoriteShops, removeFavoriteShop }
