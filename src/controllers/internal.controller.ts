import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

import {
  listLinkedShopsTodayStatus,
  updateLinkedShopsTodayStatus,
} from '../services/internal-shop-status.service'
import { applyInventoryOrderEvent } from '../services/orders.service'
import { updateShopTodayStatusSchema } from '../validation/shop-owner.validation'

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

// Shop "open today" confirmation, proxied by NearCart-Inventory on behalf of the Partner app —
// see `internal-shop-status.service.ts`. The shop is addressed by the Inventory org/branch it's
// linked to (`Shop.inventoryOrganizationId` / `inventoryBranchId`), never by NearCart shop id.
const shopTodayStatusScopeSchema = z.object({
  organizationId: z.string().trim().min(1),
  branchId: z.string().trim().min(1).optional(),
})

// Same `isOpen` / `reason` rules as the shop owner's own endpoint — extended, not re-declared.
const internalUpdateShopTodayStatusSchema = updateShopTodayStatusSchema.extend(
  shopTodayStatusScopeSchema.shape,
)

async function listShopsTodayStatusHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const scope = shopTodayStatusScopeSchema.parse(request.query)
    const result = await listLinkedShopsTodayStatus(scope)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateShopsTodayStatusHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = internalUpdateShopTodayStatusSchema.parse(request.body)
    const result = await updateLinkedShopsTodayStatus(payload)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export {
  listShopsTodayStatusHandler,
  receiveInventoryOrderEventHandler,
  updateShopsTodayStatusHandler,
}
