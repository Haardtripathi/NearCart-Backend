import { Router } from 'express'

import {
  cancelOrderHandler,
  createOrderHandler,
  createOrderReviewHandler,
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
// Ownership-checked the same way as GET /orders/:orderId (service-layer
// `assertOrderAccessible`, not a route-level role gate) — an ADMIN or the
// owning SHOP_OWNER can reach this same as they can view the order, but the
// PENDING_CONFIRMATION-only business rule is what actually limits this to
// realistically being used by the customer before a shop has acted.
router.post('/orders/:orderId/cancel', requireAuth, cancelOrderHandler)
router.post(
  '/orders/:orderId/review',
  requireAuth,
  requireRole('CUSTOMER'),
  createOrderReviewHandler,
)

export default router
