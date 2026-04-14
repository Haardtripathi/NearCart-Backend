import type { NextFunction, Response } from 'express'

import type { Request } from 'express'
import {
  createShop,
  getShopOwnerProfile,
  getShopOwnerShop,
  listShopOwnerShops,
  updateShop,
  updateShopOwnerProfile,
} from '../services/shop-owner.service'
import {
  createShopSchema,
  updateShopOwnerProfileSchema,
  updateShopSchema,
} from '../validation/shop-owner.validation'

async function getShopOwnerProfileHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getShopOwnerProfile(request.auth!.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateShopOwnerProfileHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = updateShopOwnerProfileSchema.parse(request.body)
    const result = await updateShopOwnerProfile(request.auth!.userId, payload)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function createShopHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = createShopSchema.parse(request.body)
    const result = await createShop(request.auth!.userId, payload)

    response.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

async function listShopOwnerShopsHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listShopOwnerShops(request.auth!.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function getShopOwnerShopHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getShopOwnerShop(
      request.auth!.userId,
      request.params.shopId as string,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateShopHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = updateShopSchema.parse(request.body)
    const result = await updateShop(
      request.auth!.userId,
      request.params.shopId as string,
      payload,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export {
  createShopHandler,
  getShopOwnerProfileHandler,
  getShopOwnerShopHandler,
  listShopOwnerShopsHandler,
  updateShopHandler,
  updateShopOwnerProfileHandler,
}
