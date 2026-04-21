import type { NextFunction, Request, Response } from 'express'

import {
  getPublicCatalogProduct,
  getPublicShop,
  listPublicShopCatalog,
  listPublicShops,
  validatePublicCart,
} from '../services/public-storefront.service'
import {
  publicCartValidationSchema,
  shopCatalogQuerySchema,
} from '../validation/public.validation'
import { getTimestamp } from '../utils/time'

async function listPublicShopsHandler(
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

async function getPublicShopHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getPublicShop(request.params.shopIdOrSlug as string)

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

async function listPublicShopCatalogHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = shopCatalogQuerySchema.parse(request.query)
    const result = await listPublicShopCatalog(
      request.params.shopIdOrSlug as string,
      query,
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

async function getPublicCatalogProductHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getPublicCatalogProduct(
      request.params.shopIdOrSlug as string,
      request.params.productId as string,
      typeof request.query.lang === 'string' ? request.query.lang : null,
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

async function validatePublicCartHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = publicCartValidationSchema.parse(request.body)
    const result = await validatePublicCart(payload)

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

export {
  getPublicCatalogProductHandler,
  getPublicShopHandler,
  listPublicShopCatalogHandler,
  listPublicShopsHandler,
  validatePublicCartHandler,
}
