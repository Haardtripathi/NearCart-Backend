const express = require('express')

const {
  createShopHandler,
  getShopOwnerProfileHandler,
  getShopOwnerShopHandler,
  listShopOwnerShopsHandler,
  updateShopHandler,
  updateShopOwnerProfileHandler,
} = require('../controllers/shop-owner.controller')
const { requireAuth, requireRole } = require('../middleware/auth')

const router = express.Router()

router.use(requireAuth, requireRole('SHOP_OWNER'))

router.get('/profile', getShopOwnerProfileHandler)
router.patch('/profile', updateShopOwnerProfileHandler)
router.post('/shops', createShopHandler)
router.get('/shops', listShopOwnerShopsHandler)
router.get('/shops/:shopId', getShopOwnerShopHandler)
router.patch('/shops/:shopId', updateShopHandler)

module.exports = router
