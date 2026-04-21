import type { NextFunction, Request, Response } from 'express'

import { getTimestamp } from '../utils/time'
import {
  getPublicShop,
  listPublicShops,
} from '../services/public-storefront.service'

async function listShops(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listPublicShops()

    response.status(200).json({
      ...result,
      meta: {
        ...result.meta,
        source: 'database+inventory',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

async function getShopDetails(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getPublicShop(request.params.shopId as string)

    response.status(200).json({
      ...result,
      meta: {
        source: 'database+inventory',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

export { getShopDetails, listShops }
