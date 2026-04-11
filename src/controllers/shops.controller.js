const { getShopById, shopPreviews } = require('../data/shops')
const { getInventoryBridgeMeta } = require('../services/inventory.service')
const { getTimestamp } = require('../utils/time')

const listShops = (_request, response) => {
  response.status(200).json({
    items: shopPreviews,
    meta: {
      source: 'mock',
      inventory: getInventoryBridgeMeta(),
      timestamp: getTimestamp(),
    },
  })
}

const getShopDetails = (request, response) => {
  const shop = getShopById(request.params.shopId)

  if (!shop) {
    response.status(404).json({
      error: 'Shop not found',
      meta: {
        source: 'mock',
        inventory: getInventoryBridgeMeta(),
        timestamp: getTimestamp(),
      },
    })
    return
  }

  response.status(200).json({
    item: shop,
    meta: {
      source: 'mock',
      inventory: getInventoryBridgeMeta(),
      timestamp: getTimestamp(),
    },
  })
}

module.exports = {
  getShopDetails,
  listShops,
}
