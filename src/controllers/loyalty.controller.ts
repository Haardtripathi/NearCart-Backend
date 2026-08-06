import type { NextFunction, Request, Response } from 'express'

import { getCustomerLoyaltySummary } from '../services/loyalty.service'

async function getCustomerLoyaltyHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getCustomerLoyaltySummary(request.auth!.userId)

    response.status(200).json({ item: result })
  } catch (error) {
    next(error)
  }
}

export { getCustomerLoyaltyHandler }
