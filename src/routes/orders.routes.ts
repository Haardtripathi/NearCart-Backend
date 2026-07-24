import { Router } from 'express'

import {
  createOrderHandler,
  getOrderByIdHandler,
} from '../controllers/orders.controller'
import { requireAuth, requireRole } from '../middleware/auth'
import { orderCreateRateLimiter } from '../middleware/rateLimit'

const router = Router()

router.post(
  '/orders',
  requireAuth,
  requireRole('CUSTOMER'),
  orderCreateRateLimiter,
  createOrderHandler,
)
router.get('/orders/:orderId', requireAuth, getOrderByIdHandler)

export default router
