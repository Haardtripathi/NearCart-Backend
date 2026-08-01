import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

import { applyInventoryOrderEvent } from '../services/orders.service'

const orderEventSchema = z.object({
  externalOrderId: z.string().trim().min(1),
  status: z.string().trim().min(1),
  eventType: z.enum([
    'CONFIRMED',
    'REJECTED',
    'READY',
    'DRIVER_ASSIGNED',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'AUTO_CANCELLED',
    'CANCELLED',
  ]),
  assignedDriver: z
    .object({
      fullName: z.string(),
      phone: z.string(),
      vehicleType: z.string(),
    })
    .nullable()
    .optional(),
})

async function receiveInventoryOrderEventHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = orderEventSchema.parse(request.body)
    await applyInventoryOrderEvent(payload)

    response.status(200).json({ received: true })
  } catch (error) {
    next(error)
  }
}

export { receiveInventoryOrderEventHandler }
