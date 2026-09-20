import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

import {
  listLinkedShopsTodayStatus,
  updateLinkedShopsTodayStatus,
} from '../services/internal-shop-status.service'
import {
  applyInventoryOrderEvent,
  INVENTORY_ORDER_EVENT_TYPES,
} from '../services/orders.service'
import { updateShopTodayStatusSchema } from '../validation/shop-owner.validation'

const orderEventSchema = z.object({
  externalOrderId: z.string().trim().min(1),
  status: z.string().trim().min(1),
  // Deliberately a plain string, not `z.enum(...)`: an event type this deployment doesn't know
  // about (the sibling NearCart-Inventory repo shipping a new one first — exactly what happened
  // when partial fulfilment added PARTIAL_PROPOSED/ACCEPTED/DECLINED/EXPIRED) used to fail
  // validation and come back as a 400, which reads on the Inventory side as "the webhook is
  // broken". Unknown types are now dropped quietly with a 200 by the handler below, so a
  // rollout in either order is safe.
  eventType: z.string().trim().min(1),
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
  // The shop's partial-fulfilment proposal, sent on every PARTIAL_* event. Passed through
  // unvalidated on purpose — this is a trusted, shared-secret-authenticated service-to-service
  // call, and the one consumer (`applyInventoryOrderEvent`, for the push body) treats every
  // field defensively.
  partialFulfilment: z.unknown().optional(),
})

const KNOWN_ORDER_EVENT_TYPES = new Set<string>(INVENTORY_ORDER_EVENT_TYPES)

async function receiveInventoryOrderEventHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = orderEventSchema.parse(request.body)

    if (!KNOWN_ORDER_EVENT_TYPES.has(payload.eventType)) {
      // Acknowledge and drop. The sender is fire-and-forget with no retry, so a non-2xx here
      // would just produce a confusing warning in its logs for an event we legitimately have
      // nothing to do with.
      console.warn(
        `[NearKart] Ignoring unknown inventory order event type "${payload.eventType}" for order ${payload.externalOrderId}.`,
      )
      response.status(200).json({ received: true, ignored: true })
      return
    }

    await applyInventoryOrderEvent(
      payload as Parameters<typeof applyInventoryOrderEvent>[0],
    )

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
