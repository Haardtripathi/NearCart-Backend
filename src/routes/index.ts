import { Router } from 'express'

import adminRoutes from './admin.routes'
import authRoutes from './auth.routes'
import customerRoutes from './customer.routes'
import healthRoutes from './health.routes'
import ordersRoutes from './orders.routes'
import publicRoutes from './public.routes'
import shopOwnerRoutes from './shop-owner.routes'
import shopsRoutes from './shops.routes'

const router = Router()

router.use('/auth', authRoutes)
router.use('/customer', customerRoutes)
router.use('/shop-owner', shopOwnerRoutes)
router.use('/admin', adminRoutes)
router.use(healthRoutes)
router.use(publicRoutes)
router.use(shopsRoutes)
router.use(ordersRoutes)

export default router
