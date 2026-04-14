import { Router } from 'express'

import {
  listOrdersHandler,
  listPendingShopApprovalsHandler,
  listShopsHandler,
  listUsersHandler,
  updateShopApprovalHandler,
} from '../controllers/admin.controller'
import { requireAuth, requireRole } from '../middleware/auth'

const router = Router()

router.use(requireAuth, requireRole('ADMIN'))

router.get('/users', listUsersHandler)
router.get('/shop-owners/pending', listPendingShopApprovalsHandler)
router.patch('/shops/:shopId/approval', updateShopApprovalHandler)
router.get('/shops', listShopsHandler)
router.get('/orders', listOrdersHandler)

export default router
