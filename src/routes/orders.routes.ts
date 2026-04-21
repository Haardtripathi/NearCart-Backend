import { Router } from 'express'

import {
  createOrderHandler,
  getOrderByIdHandler,
} from '../controllers/orders.controller'
import { requireAuth, requireRole } from '../middleware/auth'

const router = Router()

router.post('/orders', requireAuth, requireRole('CUSTOMER'), createOrderHandler)
router.get('/orders/:orderId', requireAuth, getOrderByIdHandler)

export default router
