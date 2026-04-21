import { Router } from 'express'

import {
  listInventoryOrganizationsHandler,
  listOrdersHandler,
  listPendingShopApprovalsHandler,
  listShopsHandler,
  listUsersHandler,
  updateShopApprovalHandler,
  updateShopStorefrontHandler,
} from '../controllers/admin.controller'
import { requireAuth, requireRole } from '../middleware/auth'

const router = Router()

router.use(requireAuth, requireRole('ADMIN'))

router.get('/users', listUsersHandler)
router.get('/shop-owners/pending', listPendingShopApprovalsHandler)
router.patch('/shops/:shopId/approval', updateShopApprovalHandler)
router.patch('/shops/:shopId/storefront', updateShopStorefrontHandler)
router.get('/shops', listShopsHandler)
router.get('/inventory/organizations', listInventoryOrganizationsHandler)
router.get('/orders', listOrdersHandler)

export default router
