import { Router } from 'express'

import {
  createShopHandler,
  getShopOwnerProfileHandler,
  getShopOwnerShopHandler,
  listShopOwnerShopsHandler,
  updateShopHandler,
  updateShopOwnerProfileHandler,
} from '../controllers/shop-owner.controller'
import { requireAuth, requireRole } from '../middleware/auth'
import { uploadShopLogoHandler } from '../modules/uploads/uploads.controller'
import { parseShopLogoUpload } from '../modules/uploads/uploads.routes'

const router = Router()

router.use(requireAuth, requireRole('SHOP_OWNER'))

router.get('/profile', getShopOwnerProfileHandler)
router.patch('/profile', updateShopOwnerProfileHandler)
router.post('/shops', createShopHandler)
router.get('/shops', listShopOwnerShopsHandler)
router.get('/shops/:shopId', getShopOwnerShopHandler)
router.patch('/shops/:shopId', updateShopHandler)
router.post('/shops/:shopId/logo', parseShopLogoUpload, uploadShopLogoHandler)

export default router
