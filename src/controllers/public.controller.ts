import type { NextFunction, Request, Response } from 'express'

import {
  getPublicCatalogProduct,
  getPublicShop,
  listPublicShopCatalog,
  listPublicShopCategories,
  listPublicShops,
  listTrendingProducts,
  searchPublicCatalog,
  validatePublicCart,
} from '../services/public-storefront.service'
import {
  publicCartValidationSchema,
  publicSearchQuerySchema,
  publicTrendingQuerySchema,
  shopCatalogQuerySchema,
  shopGeoQuerySchema,
  shopListQuerySchema,
} from '../validation/public.validation'
import { getTimestamp } from '../utils/time'

async function listPublicShopsHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = shopListQuerySchema.parse(request.query)
    const result = await listPublicShops(
      query.lat != null && query.lng != null
        ? { latitude: query.lat, longitude: query.lng }
        : null,
      { search: query.search || undefined, category: query.category || undefined },
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

async function listPublicShopCategoriesHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listPublicShopCategories()

    response.status(200).json({
      ...result,
      meta: {
        source: 'database',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

async function searchPublicCatalogHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = publicSearchQuerySchema.parse(request.query)
    const result = await searchPublicCatalog(query.q, {
      category: query.category || undefined,
      limit: query.limit,
      language: query.lang || undefined,
    })

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

async function listTrendingProductsHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = publicTrendingQuerySchema.parse(request.query)
    const result = await listTrendingProducts({
      category: query.category || undefined,
      limit: query.limit,
      language: query.lang || undefined,
    })

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
    const geo = shopGeoQuerySchema.parse(request.query)
    const result = await getPublicShop(
      request.params.shopIdOrSlug as string,
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
      query.lat != null && query.lng != null
        ? { latitude: query.lat, longitude: query.lng }
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

async function getPublicCatalogProductHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const geo = shopGeoQuerySchema.parse(request.query)
    const result = await getPublicCatalogProduct(
      request.params.shopIdOrSlug as string,
      request.params.productId as string,
      typeof request.query.lang === 'string' ? request.query.lang : null,
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
  listPublicShopCategoriesHandler,
  listPublicShopsHandler,
  listTrendingProductsHandler,
  searchPublicCatalogHandler,
  validatePublicCartHandler,
}
