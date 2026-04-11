const express = require('express')

const {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerCustomerHandler,
  registerShopOwnerHandler,
} = require('../controllers/auth.controller')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

router.post('/register/customer', registerCustomerHandler)
router.post('/register/shop-owner', registerShopOwnerHandler)
router.post('/login', loginHandler)
router.post('/logout', logoutHandler)
router.get('/me', requireAuth, meHandler)
router.post('/refresh', refreshHandler)

module.exports = router
