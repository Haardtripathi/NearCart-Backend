import { Router } from 'express'

import {
  createCustomerAddressHandler,
  deleteCustomerAddressHandler,
  getCustomerProfileHandler,
  listCustomerAddressesHandler,
  listCustomerOrdersHandler,
  updateCustomerAddressHandler,
  updateCustomerProfileHandler,
} from '../controllers/customer.controller'
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

export default router
