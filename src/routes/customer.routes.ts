import { Router } from 'express'

import {
  addFavoriteShopHandler,
  createCustomerAddressHandler,
  deleteCustomerAddressHandler,
  getCustomerProfileHandler,
  listCustomerAddressesHandler,
  listCustomerOrdersHandler,
  listFavoriteShopIdsHandler,
  listFavoriteShopsHandler,
  registerCustomerDeviceTokenHandler,
  removeFavoriteShopHandler,
  updateCustomerAddressHandler,
  updateCustomerProfileHandler,
} from '../controllers/customer.controller'
import { validateCouponHandler } from '../controllers/coupon.controller'
import { getCustomerLoyaltyHandler } from '../controllers/loyalty.controller'
import { requireAuth, requireRole } from '../middleware/auth'

const router = Router()

router.use(requireAuth, requireRole('CUSTOMER'))

router.get('/profile', getCustomerProfileHandler)
router.patch('/profile', updateCustomerProfileHandler)
router.get('/addresses', listCustomerAddressesHandler)
router.post('/addresses', createCustomerAddressHandler)
router.patch('/addresses/:id', updateCustomerAddressHandler)
router.delete('/addresses/:id', deleteCustomerAddressHandler)
router.get('/orders', listCustomerOrdersHandler)
router.post('/device-token', registerCustomerDeviceTokenHandler)
router.get('/favorites/shops', listFavoriteShopsHandler)
router.get('/favorites/shops/ids', listFavoriteShopIdsHandler)
router.post('/favorites/shops/:shopId', addFavoriteShopHandler)
router.delete('/favorites/shops/:shopId', removeFavoriteShopHandler)
router.post('/coupons/validate', validateCouponHandler)
router.get('/loyalty', getCustomerLoyaltyHandler)

export default router
