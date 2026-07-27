import { Router } from 'express'

import { receiveInventoryOrderEventHandler } from '../controllers/internal.controller'
import { requireInternalServiceAuth } from '../middleware/internalService'

const router = Router()

router.use('/internal', requireInternalServiceAuth)
router.post('/internal/order-events', receiveInventoryOrderEventHandler)

export default router
