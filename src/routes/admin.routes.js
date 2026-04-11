const express = require('express')

const {
  listOrdersHandler,
  listPendingShopApprovalsHandler,
  listShopsHandler,
  listUsersHandler,
  updateShopApprovalHandler,
} = require('../controllers/admin.controller')
const { requireAuth, requireRole } = require('../middleware/auth')

const router = express.Router()

router.use(requireAuth, requireRole('ADMIN'))

router.get('/users', listUsersHandler)
router.get('/shop-owners/pending', listPendingShopApprovalsHandler)
router.patch('/shops/:shopId/approval', updateShopApprovalHandler)
router.get('/shops', listShopsHandler)
router.get('/orders', listOrdersHandler)

module.exports = router
