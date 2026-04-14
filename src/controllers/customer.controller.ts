import type { NextFunction, Response } from 'express'

import type { Request } from 'express'
import {
  createCustomerAddress,
  deleteCustomerAddress,
  getCustomerProfile,
  listCustomerAddresses,
  listCustomerOrders,
  updateCustomerAddress,
  updateCustomerProfile,
} from '../services/customer.service'
import {
  createAddressSchema,
  updateAddressSchema,
  updateCustomerProfileSchema,
} from '../validation/customer.validation'

async function getCustomerProfileHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getCustomerProfile(request.auth!.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateCustomerProfileHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = updateCustomerProfileSchema.parse(request.body)
    const result = await updateCustomerProfile(request.auth!.userId, payload)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listCustomerAddressesHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listCustomerAddresses(request.auth!.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function createCustomerAddressHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = createAddressSchema.parse(request.body)
    const result = await createCustomerAddress(request.auth!.userId, payload)

    response.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateCustomerAddressHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = updateAddressSchema.parse(request.body)
    const result = await updateCustomerAddress(
      request.auth!.userId,
      request.params.id as string,
      payload,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function deleteCustomerAddressHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await deleteCustomerAddress(
      request.auth!.userId,
      request.params.id as string,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listCustomerOrdersHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listCustomerOrders(request.auth!.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

export {
  createCustomerAddressHandler,
  deleteCustomerAddressHandler,
  getCustomerProfileHandler,
  listCustomerAddressesHandler,
  listCustomerOrdersHandler,
  updateCustomerAddressHandler,
  updateCustomerProfileHandler,
}
