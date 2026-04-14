import { Router } from 'express'

import { getShopDetails, listShops } from '../controllers/shops.controller'

const router = Router()

router.get('/shops', listShops)
router.get('/shops/:shopId', getShopDetails)

export default router
