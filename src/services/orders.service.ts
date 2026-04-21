import type { Prisma } from '@prisma/client'

import prisma from '../lib/prisma'
import { getAuthoritativeCheckoutSnapshot } from './public-storefront.service'
import { createHttpError } from '../utils/httpError'
import { mapOrder, mapOrderPreview } from '../utils/serializers'
import { normalizeOptionalString } from '../utils/user'
import type { CheckoutPayloadInput } from '../validation/orders.validation'

interface CreateOrderOptions {
  customerUserId?: string | null
}

async function createOrderNumber(
  transaction: Prisma.TransactionClient,
  placedAt: Date,
): Promise<string> {
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

async function resolveCustomerAddress(
  customerUserId: string | null | undefined,
  addressId: string | null,
) {
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

async function createOrder(
  payload: CheckoutPayloadInput,
  options: CreateOrderOptions = {},
) {
  const placedAt = new Date()
  const customerAddress = await resolveCustomerAddress(
    options.customerUserId,
    normalizeOptionalString(payload.addressId),
  )
  const checkoutSnapshot = await getAuthoritativeCheckoutSnapshot({
    shopId: payload.shopId,
    items: payload.items,
  })
  const { shop } = checkoutSnapshot

  if (
    shop.minimumOrderAmount > 0 &&
    checkoutSnapshot.summary.subtotal < shop.minimumOrderAmount
  ) {
    throw createHttpError(
      400,
      `Minimum order amount for ${shop.name} is ${shop.minimumOrderAmount}.`,
      {
        minimumOrderAmount: shop.minimumOrderAmount,
        subtotal: checkoutSnapshot.summary.subtotal,
      },
    )
  }

  const createdOrder = await prisma.$transaction(async (transaction) => {
    const orderNumber = await createOrderNumber(transaction, placedAt)

    return transaction.order.create({
      data: {
        orderNumber,
        customerUserId: options.customerUserId || null,
        shopId: shop.slug,
        shopRecordId: shop.id,
        shopName: shop.name,
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
        subtotal: checkoutSnapshot.summary.subtotal,
        deliveryFee: checkoutSnapshot.summary.deliveryFee,
        platformFee: 0,
        totalAmount: checkoutSnapshot.summary.totalAmount,
        createdAt: placedAt,
        placedAt,
        items: {
          create: checkoutSnapshot.appliedItems.map((item) => ({
            storeProductId: item.productId,
            inventoryProductId: item.productId,
            inventoryVariantId: item.variantId ?? null,
            name: item.name ?? 'Catalog item',
            brand: item.brand?.name ?? null,
            size: item.unitLabel ?? null,
            unitLabel: item.unitLabel ?? null,
            image: item.image ?? null,
            price: item.price ?? 0,
            mrp: item.mrp ?? null,
            quantity: item.quantity,
            lineTotal: (item.price ?? 0) * item.quantity,
          })),
        },
      },
      include: {
        items: true,
      },
    })
  })

  return mapOrder(createdOrder)
}

async function getOrderById(orderId: string) {
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

export { createOrder, getOrderById, listOrders }
