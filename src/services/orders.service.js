const prisma = require('../lib/prisma')
const { createHttpError } = require('../utils/httpError')

function normalizeOptionalString(value) {
  const normalizedValue = value?.trim()

  return normalizedValue ? normalizedValue : null
}

function mapOrderItemForResponse(item) {
  return {
    id: item.id,
    orderId: item.orderId,
    storeProductId: item.storeProductId,
    name: item.name,
    brand: item.brand,
    size: item.size,
    image: item.image,
    price: item.price,
    mrp: item.mrp,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
  }
}

function mapOrderForResponse(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    shopId: order.shopId,
    shopName: order.shopName,
    status: order.status,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail,
    deliveryAddressLine1: order.deliveryAddressLine1,
    deliveryAddressLine2: order.deliveryAddressLine2,
    city: order.city,
    area: order.area,
    pincode: order.pincode,
    notes: order.notes,
    paymentMethod: order.paymentMethod,
    subtotal: order.subtotal,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
    placedAt: order.placedAt,
    items: order.items.map(mapOrderItemForResponse),
  }
}

function mapOrderPreview(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    totalAmount: order.totalAmount,
    shopName: order.shopName,
    customerName: order.customerName,
    placedAt: order.placedAt,
  }
}

async function createOrderNumber(transaction, placedAt) {
  const datePrefix = placedAt.toISOString().slice(0, 10).replaceAll('-', '')
  const dayStart = new Date(placedAt)
  dayStart.setUTCHours(0, 0, 0, 0)

  const dayEnd = new Date(placedAt)
  dayEnd.setUTCHours(23, 59, 59, 999)

  const existingOrdersCount = await transaction.order.count({
    where: {
      createdAt: {
        gte: dayStart,
        lte: dayEnd,
      },
    },
  })

  return `NC-${datePrefix}-${String(existingOrdersCount + 1).padStart(4, '0')}`
}

function buildOrderItems(items, shopId) {
  const uniqueShopIds = new Set(items.map((item) => item.shopId))

  if (uniqueShopIds.size !== 1 || !uniqueShopIds.has(shopId)) {
    throw createHttpError(
      400,
      'All cart items must belong to the same shop as the checkout request.',
    )
  }

  return items.map((item) => ({
    storeProductId: item.storeProductId,
    name: item.name,
    brand: normalizeOptionalString(item.brand),
    size: normalizeOptionalString(item.size),
    image: normalizeOptionalString(item.image),
    price: item.price,
    mrp: item.mrp ?? null,
    quantity: item.quantity,
    lineTotal: item.price * item.quantity,
  }))
}

async function createOrder(payload) {
  const orderItems = buildOrderItems(payload.items, payload.shopId)
  const subtotal = orderItems.reduce((sum, item) => sum + item.lineTotal, 0)
  const placedAt = new Date()

  const createdOrder = await prisma.$transaction(async (transaction) => {
    const orderNumber = await createOrderNumber(transaction, placedAt)

    return transaction.order.create({
      data: {
        orderNumber,
        shopId: payload.shopId,
        shopName: payload.shopName,
        status: 'PENDING',
        customerName: payload.customerName.trim(),
        customerPhone: payload.customerPhone.trim(),
        customerEmail: normalizeOptionalString(payload.customerEmail),
        deliveryAddressLine1: payload.deliveryAddressLine1.trim(),
        deliveryAddressLine2: normalizeOptionalString(payload.deliveryAddressLine2),
        city: payload.city.trim(),
        area: normalizeOptionalString(payload.area),
        pincode: payload.pincode.trim(),
        notes: normalizeOptionalString(payload.notes),
        paymentMethod: payload.paymentMethod,
        subtotal,
        totalAmount: subtotal,
        createdAt: placedAt,
        placedAt,
        items: {
          create: orderItems,
        },
      },
      include: {
        items: true,
      },
    })
  })

  return mapOrderForResponse(createdOrder)
}

async function getOrderById(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
    },
  })

  if (!order) {
    throw createHttpError(404, 'Order not found')
  }

  return mapOrderForResponse(order)
}

async function listOrders() {
  const orders = await prisma.order.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    take: 20,
  })

  return orders.map(mapOrderPreview)
}

module.exports = {
  createOrder,
  getOrderById,
  listOrders,
}
