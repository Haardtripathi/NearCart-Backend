import type { NextFunction, Request, Response } from 'express'

import {
  listOrders,
  listPendingShopApprovals,
  listShops,
  listUsers,
  updateShopApproval,
} from '../services/admin.service'
import { updateShopApprovalSchema } from '../validation/admin.validation'

async function listUsersHandler(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listUsers()

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listPendingShopApprovalsHandler(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listPendingShopApprovals()

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateShopApprovalHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = updateShopApprovalSchema.parse(request.body)
    const result = await updateShopApproval(
      request.params.shopId as string,
      payload.approvalStatus,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listShopsHandler(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listShops()

    response.status(200).json(result)
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
    const result = await listOrders()

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export {
  listOrdersHandler,
  listPendingShopApprovalsHandler,
  listShopsHandler,
  listUsersHandler,
  updateShopApprovalHandler,
}
