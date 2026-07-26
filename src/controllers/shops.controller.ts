import type { NextFunction, Request, Response } from 'express'

import { getTimestamp } from '../utils/time'
import {
  getPublicShop,
  listPublicShops,
} from '../services/public-storefront.service'
import { shopGeoQuerySchema } from '../validation/public.validation'

async function listShops(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const geo = shopGeoQuerySchema.parse(request.query)
    const result = await listPublicShops(
      geo.lat != null && geo.lng != null
        ? { latitude: geo.lat, longitude: geo.lng }
        : null,
    )

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
    const geo = shopGeoQuerySchema.parse(request.query)
    const result = await getPublicShop(
      request.params.shopId as string,
      geo.lat != null && geo.lng != null
        ? { latitude: geo.lat, longitude: geo.lng }
        : null,
    )

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
