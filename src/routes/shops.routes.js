const express = require('express')

const { getShopDetails, listShops } = require('../controllers/shops.controller')

const router = express.Router()

router.get('/shops', listShops)
router.get('/shops/:shopId', getShopDetails)

module.exports = router
