const {
  listOrders,
  listPendingShopApprovals,
  listShops,
  listUsers,
  updateShopApproval,
} = require('../services/admin.service')
const { updateShopApprovalSchema } = require('../validation/admin.validation')

async function listUsersHandler(_request, response, next) {
  try {
    const result = await listUsers()

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listPendingShopApprovalsHandler(_request, response, next) {
  try {
    const result = await listPendingShopApprovals()

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function updateShopApprovalHandler(request, response, next) {
  try {
    const payload = updateShopApprovalSchema.parse(request.body)
    const result = await updateShopApproval(
      request.params.shopId,
      payload.approvalStatus,
    )

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listShopsHandler(_request, response, next) {
  try {
    const result = await listShops()

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function listOrdersHandler(_request, response, next) {
  try {
    const result = await listOrders()

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

module.exports = {
  listOrdersHandler,
  listPendingShopApprovalsHandler,
  listShopsHandler,
  listUsersHandler,
  updateShopApprovalHandler,
}
