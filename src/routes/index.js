const express = require('express')

const adminRoutes = require('./admin.routes')
const authRoutes = require('./auth.routes')
const customerRoutes = require('./customer.routes')
const healthRoutes = require('./health.routes')
const ordersRoutes = require('./orders.routes')
const shopOwnerRoutes = require('./shop-owner.routes')
const shopsRoutes = require('./shops.routes')

const router = express.Router()

router.use('/auth', authRoutes)
router.use('/customer', customerRoutes)
router.use('/shop-owner', shopOwnerRoutes)
router.use('/admin', adminRoutes)
router.use(healthRoutes)
router.use(shopsRoutes)
router.use(ordersRoutes)

module.exports = router
