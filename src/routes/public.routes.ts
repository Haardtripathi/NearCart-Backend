import { Router } from 'express'

import {
  getPublicCatalogProductHandler,
  getPublicShopHandler,
  listPublicShopCatalogHandler,
  listPublicShopCategoriesHandler,
  listPublicShopsHandler,
  listShopReviewsHandler,
  listTrendingProductsHandler,
  searchPublicCatalogHandler,
  validatePublicCartHandler,
} from '../controllers/public.controller'
import { publicApiRateLimiter } from '../middleware/rateLimit'

const router = Router()

router.use(publicApiRateLimiter)

router.get('/public/categories', listPublicShopCategoriesHandler)
router.get('/public/search', searchPublicCatalogHandler)
router.get('/public/trending', listTrendingProductsHandler)
router.get('/public/shops', listPublicShopsHandler)
router.get('/public/shops/:shopIdOrSlug', getPublicShopHandler)
router.get('/public/shops/:shopIdOrSlug/catalog', listPublicShopCatalogHandler)
router.get(
  '/public/shops/:shopIdOrSlug/catalog/:productId',
  getPublicCatalogProductHandler,
)
router.get('/public/shops/:shopIdOrSlug/reviews', listShopReviewsHandler)
router.post('/public/cart/validate', validatePublicCartHandler)

export default router
