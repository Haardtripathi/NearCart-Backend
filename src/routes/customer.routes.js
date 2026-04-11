const express = require('express')

const {
  createCustomerAddressHandler,
  deleteCustomerAddressHandler,
  getCustomerProfileHandler,
  listCustomerAddressesHandler,
  listCustomerOrdersHandler,
  updateCustomerAddressHandler,
  updateCustomerProfileHandler,
} = require('../controllers/customer.controller')
const { requireAuth, requireRole } = require('../middleware/auth')

const router = express.Router()

router.use(requireAuth, requireRole('CUSTOMER'))

router.get('/profile', getCustomerProfileHandler)
router.patch('/profile', updateCustomerProfileHandler)
router.get('/addresses', listCustomerAddressesHandler)
router.post('/addresses', createCustomerAddressHandler)
router.patch('/addresses/:id', updateCustomerAddressHandler)
router.delete('/addresses/:id', deleteCustomerAddressHandler)
router.get('/orders', listCustomerOrdersHandler)

module.exports = router
