import { Router } from 'express'

import {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerCustomerHandler,
  registerShopOwnerHandler,
} from '../controllers/auth.controller'
import { sendOtpHandler, verifyOtpHandler } from '../controllers/otp.controller'
import { requireAuth } from '../middleware/auth'
import { authRateLimiter, otpRateLimiter } from '../middleware/rateLimit'

const router = Router()

router.post(
  '/register/customer',
  authRateLimiter,
  registerCustomerHandler,
)
router.post(
  '/register/shop-owner',
  authRateLimiter,
  registerShopOwnerHandler,
)
router.post('/login', authRateLimiter, loginHandler)
router.post('/logout', logoutHandler)
router.get('/me', requireAuth, meHandler)
router.post('/refresh', refreshHandler)

// Email OTP verification (sets User.isVerified = true on success).
router.post('/otp/send', requireAuth, otpRateLimiter, sendOtpHandler)
router.post('/otp/verify', requireAuth, otpRateLimiter, verifyOtpHandler)

export default router
