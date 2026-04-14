import { Router } from 'express'

import {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerCustomerHandler,
  registerShopOwnerHandler,
} from '../controllers/auth.controller'
import { requireAuth } from '../middleware/auth'

const router = Router()

router.post('/register/customer', registerCustomerHandler)
router.post('/register/shop-owner', registerShopOwnerHandler)
router.post('/login', loginHandler)
router.post('/logout', logoutHandler)
router.get('/me', requireAuth, meHandler)
router.post('/refresh', refreshHandler)

export default router
