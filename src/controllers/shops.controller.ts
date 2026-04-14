import type { Request, Response } from 'express'

import { getShopById, shopPreviews } from '../data/shops'
import { getInventoryBridgeMeta } from '../services/inventory.service'
import { getTimestamp } from '../utils/time'

const listShops = (_request: Request, response: Response): void => {
  response.status(200).json({
    items: shopPreviews,
    meta: {
      source: 'mock',
      inventory: getInventoryBridgeMeta(),
      timestamp: getTimestamp(),
    },
  })
}

const getShopDetails = (request: Request, response: Response): void => {
  const shop = getShopById(request.params.shopId as string)

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

export { getShopDetails, listShops }
