import type { NextFunction, Request, Response } from 'express'

import { getTimestamp } from '../utils/time'
import {
  createOrder,
  getOrderById,
  listOrders,
} from '../services/orders.service'
import { checkoutPayloadSchema } from '../validation/orders.validation'

async function createOrderHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = checkoutPayloadSchema.parse(request.body)
    const order = await createOrder(payload, {
      customerUserId:
        request.auth?.user?.role === 'CUSTOMER' ? request.auth.userId : null,
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
    const order = await getOrderById(request.params.orderId as string)

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

async function listOrdersHandler(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const items = await listOrders()

    response.status(200).json({
      items,
      meta: {
        source: 'database',
        timestamp: getTimestamp(),
      },
    })
  } catch (error) {
    next(error)
  }
}

export { createOrderHandler, getOrderByIdHandler, listOrdersHandler }
