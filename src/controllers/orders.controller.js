const { getTimestamp } = require('../utils/time')
const {
  createOrder,
  getOrderById,
  listOrders,
} = require('../services/orders.service')
const { checkoutPayloadSchema } = require('../validation/orders.validation')

async function createOrderHandler(request, response, next) {
  try {
    const payload = checkoutPayloadSchema.parse(request.body)
    const order = await createOrder(payload)

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

async function getOrderByIdHandler(request, response, next) {
  try {
    const order = await getOrderById(request.params.orderId)

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

async function listOrdersHandler(_request, response, next) {
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

module.exports = {
  createOrderHandler,
  getOrderByIdHandler,
  listOrdersHandler,
}
