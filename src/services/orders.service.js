const prisma = require('../lib/prisma')
const { mapOrder, mapOrderPreview } = require('../utils/serializers')
const { createHttpError } = require('../utils/httpError')
const { normalizeOptionalString } = require('../utils/user')

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

async function resolveOrderShop(shopId) {
  return prisma.shop.findFirst({
    where: {
      OR: [{ slug: shopId }, { id: shopId }],
      approvalStatus: 'APPROVED',
      isActive: true,
    },
  })
}

async function resolveCustomerAddress(customerUserId, addressId) {
  if (!addressId) {
    return null
  }

  if (!customerUserId) {
    throw createHttpError(400, 'Saved addresses can only be used by signed-in customers')
  }

  const address = await prisma.address.findFirst({
    where: {
      id: addressId,
      userId: customerUserId,
    },
  })

  if (!address) {
    throw createHttpError(404, 'Saved address not found')
  }

  return address
}

async function createOrder(payload, options = {}) {
  const orderItems = buildOrderItems(payload.items, payload.shopId)
  const subtotal = orderItems.reduce((sum, item) => sum + item.lineTotal, 0)
  const placedAt = new Date()
  const customerAddress = await resolveCustomerAddress(
    options.customerUserId,
    normalizeOptionalString(payload.addressId),
  )
  const shop = await resolveOrderShop(payload.shopId)
  const deliveryFee = 0
  const platformFee = 0
  const totalAmount = subtotal + deliveryFee + platformFee

  const createdOrder = await prisma.$transaction(async (transaction) => {
    const orderNumber = await createOrderNumber(transaction, placedAt)

    return transaction.order.create({
      data: {
        orderNumber,
        customerUserId: options.customerUserId || null,
        shopId: shop?.slug || payload.shopId,
        shopRecordId: shop?.id || null,
        shopName: shop?.name || payload.shopName.trim(),
        status: 'PENDING_CONFIRMATION',
        paymentStatus: 'PENDING',
        customerName: payload.customerName.trim(),
        customerPhone: payload.customerPhone.trim(),
        customerEmail: normalizeOptionalString(payload.customerEmail),
        deliveryAddressId: customerAddress?.id ?? null,
        deliveryAddressLabel: customerAddress?.label ?? null,
        deliveryAddressLine1:
          customerAddress?.line1 ?? payload.deliveryAddressLine1.trim(),
        deliveryAddressLine2:
          customerAddress?.line2 ??
          normalizeOptionalString(payload.deliveryAddressLine2),
        city: customerAddress?.city ?? payload.city.trim(),
        area: customerAddress?.area ?? normalizeOptionalString(payload.area),
        pincode: customerAddress?.pincode ?? payload.pincode.trim(),
        landmark:
          customerAddress?.landmark ?? normalizeOptionalString(payload.landmark),
        latitude: customerAddress?.latitude ?? null,
        longitude: customerAddress?.longitude ?? null,
        notes: normalizeOptionalString(payload.notes),
        paymentMethod: payload.paymentMethod,
        subtotal,
        deliveryFee,
        platformFee,
        totalAmount,
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

  return mapOrder(createdOrder)
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

  return mapOrder(order)
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
