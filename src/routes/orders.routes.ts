import { Router } from 'express'

import {
  createOrderHandler,
  getOrderByIdHandler,
  listOrdersHandler,
} from '../controllers/orders.controller'
import { optionalAuth } from '../middleware/auth'

const router = Router()

router.post('/orders', optionalAuth, createOrderHandler)
router.get('/orders', listOrdersHandler)
router.get('/orders/:orderId', getOrderByIdHandler)

export default router
