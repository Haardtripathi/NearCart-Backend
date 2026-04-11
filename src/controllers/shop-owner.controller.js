const {
  createShop,
  getShopOwnerProfile,
  getShopOwnerShop,
  listShopOwnerShops,
  updateShop,
  updateShopOwnerProfile,
} = require('../services/shop-owner.service')
const {
  createShopSchema,
  updateShopOwnerProfileSchema,
  updateShopSchema,
} = require('../validation/shop-owner.validation')

async function getShopOwnerProfileHandler(request, response, next) {
  try {
    const result = await getShopOwnerProfile(request.auth.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateShopOwnerProfileHandler(request, response, next) {
  try {
    const payload = updateShopOwnerProfileSchema.parse(request.body)
    const result = await updateShopOwnerProfile(request.auth.userId, payload)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function createShopHandler(request, response, next) {
  try {
    const payload = createShopSchema.parse(request.body)
    const result = await createShop(request.auth.userId, payload)

    response.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

async function listShopOwnerShopsHandler(request, response, next) {
  try {
    const result = await listShopOwnerShops(request.auth.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function getShopOwnerShopHandler(request, response, next) {
  try {
    const result = await getShopOwnerShop(request.auth.userId, request.params.shopId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateShopHandler(request, response, next) {
  try {
    const payload = updateShopSchema.parse(request.body)
    const result = await updateShop(
      request.auth.userId,
      request.params.shopId,
      payload,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

module.exports = {
  createShopHandler,
  getShopOwnerProfileHandler,
  getShopOwnerShopHandler,
  listShopOwnerShopsHandler,
  updateShopHandler,
  updateShopOwnerProfileHandler,
}
