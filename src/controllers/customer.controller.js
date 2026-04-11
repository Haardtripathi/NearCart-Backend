const {
  createCustomerAddress,
  deleteCustomerAddress,
  getCustomerProfile,
  listCustomerAddresses,
  listCustomerOrders,
  updateCustomerAddress,
  updateCustomerProfile,
} = require('../services/customer.service')
const {
  createAddressSchema,
  updateAddressSchema,
  updateCustomerProfileSchema,
} = require('../validation/customer.validation')

async function getCustomerProfileHandler(request, response, next) {
  try {
    const result = await getCustomerProfile(request.auth.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateCustomerProfileHandler(request, response, next) {
  try {
    const payload = updateCustomerProfileSchema.parse(request.body)
    const result = await updateCustomerProfile(request.auth.userId, payload)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listCustomerAddressesHandler(request, response, next) {
  try {
    const result = await listCustomerAddresses(request.auth.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function createCustomerAddressHandler(request, response, next) {
  try {
    const payload = createAddressSchema.parse(request.body)
    const result = await createCustomerAddress(request.auth.userId, payload)

    response.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateCustomerAddressHandler(request, response, next) {
  try {
    const payload = updateAddressSchema.parse(request.body)
    const result = await updateCustomerAddress(
      request.auth.userId,
      request.params.id,
      payload,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function deleteCustomerAddressHandler(request, response, next) {
  try {
    const result = await deleteCustomerAddress(
      request.auth.userId,
      request.params.id,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listCustomerOrdersHandler(request, response, next) {
  try {
    const result = await listCustomerOrders(request.auth.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

module.exports = {
  createCustomerAddressHandler,
  deleteCustomerAddressHandler,
  getCustomerProfileHandler,
  listCustomerAddressesHandler,
  listCustomerOrdersHandler,
  updateCustomerAddressHandler,
  updateCustomerProfileHandler,
}
