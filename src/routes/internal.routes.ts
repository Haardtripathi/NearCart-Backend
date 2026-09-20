import { Router } from 'express'

import {
  listShopsTodayStatusHandler,
  receiveInventoryOrderEventHandler,
  updateShopsTodayStatusHandler,
} from '../controllers/internal.controller'
import { requireInternalServiceAuth } from '../middleware/internalService'

const router = Router()

router.use('/internal', requireInternalServiceAuth)
router.post('/internal/order-events', receiveInventoryOrderEventHandler)
router.get('/internal/shops/today-status', listShopsTodayStatusHandler)
router.patch('/internal/shops/today-status', updateShopsTodayStatusHandler)

export default router
