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
    'DRIVER_UNASSIGNED',
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
  // Delivery-proof photo (Cloudinary URL), sent by NearCart-Inventory on a DELIVERED event.
  // Optional/nullable so payloads from before that sibling repo ships its side of this — or a
  // DELIVERED event where the driver simply didn't capture a photo — still validate cleanly.
  deliveryProofPhotoUrl: z.string().trim().min(1).nullable().optional(),
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
