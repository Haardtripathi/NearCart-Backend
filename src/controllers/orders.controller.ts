import type { NextFunction, Request, Response } from 'express'

import { getTimestamp } from '../utils/time'
import {
  cancelOrder,
  createOrder,
  getOrderById,
} from '../services/orders.service'
import { createOrderReview } from '../services/order-review.service'
import { checkoutPayloadSchema } from '../validation/orders.validation'
import { createOrderReviewSchema } from '../validation/order-review.validation'

async function createOrderHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = checkoutPayloadSchema.parse(request.body)
    const order = await createOrder(payload, {
      customerUserId: request.auth!.userId,
    })

    response.status(201).json({
      item: order,
      meta: {
        source: 'database',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

async function getOrderByIdHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const order = await getOrderById(request.params.orderId as string, {
      userId: request.auth!.userId,
      role: request.auth!.role,
      shopOwnerProfileId: request.auth!.user.shopOwnerProfile?.id ?? null,
    })

    response.status(200).json({
      item: order,
      meta: {
        source: 'database',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

async function cancelOrderHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const order = await cancelOrder(request.params.orderId as string, {
      userId: request.auth!.userId,
      role: request.auth!.role,
      shopOwnerProfileId: request.auth!.user.shopOwnerProfile?.id ?? null,
    })

    response.status(200).json({
      item: order,
      meta: {
        source: 'database',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

async function createOrderReviewHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = createOrderReviewSchema.parse(request.body)
    const review = await createOrderReview(payload, {
      orderId: request.params.orderId as string,
      customerUserId: request.auth!.userId,
    })

    response.status(201).json({
      item: review,
      meta: {
        source: 'database',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

export {
  cancelOrderHandler,
  createOrderHandler,
  createOrderReviewHandler,
  getOrderByIdHandler,
}
