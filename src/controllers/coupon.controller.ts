import type { NextFunction, Request, Response } from 'express'

import { previewCoupon } from '../services/coupon.service'
import { validateCouponSchema } from '../validation/coupon.validation'

async function validateCouponHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = validateCouponSchema.parse(request.body)
    const result = await previewCoupon(request.auth!.userId, payload.code, payload.subtotal)

    response.status(200).json({ item: result })
  } catch (error) {
    next(error)
  }
}

export { validateCouponHandler }
