const express = require('express')

const {
  createOrderHandler,
  getOrderByIdHandler,
  listOrdersHandler,
} = require('../controllers/orders.controller')
const { optionalAuth } = require('../middleware/auth')

const router = express.Router()

router.post('/orders', optionalAuth, createOrderHandler)
router.get('/orders', listOrdersHandler)
router.get('/orders/:orderId', getOrderByIdHandler)

module.exports = router
