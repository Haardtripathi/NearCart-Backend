import type { NextFunction, Request, Response } from 'express'

import { assertShopOwnership } from '../../services/shop-owner.service'
import { createHttpError } from '../../utils/httpError'
import { buildMeta } from '../../utils/response'
import { uploadShopLogo } from './uploads.service'

async function uploadShopLogoHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const shopId = request.params.shopId as string

    await assertShopOwnership(request.auth!.userId, shopId)

    if (!request.file) {
      throw createHttpError(400, 'Image file is required')
    }

    const result = await uploadShopLogo({
      fileBuffer: request.file.buffer,
      shopId,
    })

    response.status(201).json({
      item: { url: result.url },
      meta: buildMeta(),
    })
  } catch (error) {
    next(error)
  }
}

export { uploadShopLogoHandler }
