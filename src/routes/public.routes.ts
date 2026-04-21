import { Router } from 'express'

import {
  getPublicCatalogProductHandler,
  getPublicShopHandler,
  listPublicShopCatalogHandler,
  listPublicShopsHandler,
  validatePublicCartHandler,
} from '../controllers/public.controller'

const router = Router()

router.get('/public/shops', listPublicShopsHandler)
router.get('/public/shops/:shopIdOrSlug', getPublicShopHandler)
router.get('/public/shops/:shopIdOrSlug/catalog', listPublicShopCatalogHandler)
router.get(
  '/public/shops/:shopIdOrSlug/catalog/:productId',
  getPublicCatalogProductHandler,
)
router.post('/public/cart/validate', validatePublicCartHandler)

export default router
