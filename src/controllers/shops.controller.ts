import type { NextFunction, Request, Response } from 'express'

import { getTimestamp } from '../utils/time'
import {
  getPublicShop,
  listPublicShops,
} from '../services/public-storefront.service'
import { shopGeoQuerySchema, shopListQuerySchema } from '../validation/public.validation'

async function listShops(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Same query contract as `GET /public/shops` — this legacy route used to parse only lat/lng,
    // so it always served page 1 (50 shops) with no way to reach the rest or to filter.
    const query = shopListQuerySchema.parse(request.query)
    const result = await listPublicShops(
      query.lat != null && query.lng != null
        ? { latitude: query.lat, longitude: query.lng }
        : null,
      {
        search: query.search || undefined,
        category: query.category || undefined,
        city: query.city || undefined,
      },
      { page: query.page, limit: query.limit },
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
