const express = require('express')

const healthRoutes = require('./health.routes')
const ordersRoutes = require('./orders.routes')
const shopsRoutes = require('./shops.routes')

const router = express.Router()

router.use(healthRoutes)
router.use(shopsRoutes)
router.use(ordersRoutes)

module.exports = router
