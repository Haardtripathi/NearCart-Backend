import type { Prisma } from '@prisma/client'

import prisma from '../lib/prisma'
import { loadPartialFulfilmentsForOrderList } from './orders.service'
import { buildMeta } from '../utils/response'
import {
  mapAddress,
  mapCustomerProfile,
  mapOrderPreview,
  mapSafeUser,
} from '../utils/serializers'
import { createHttpError } from '../utils/httpError'
import { normalizeOptionalString } from '../utils/user'
import type {
  CreateAddressInput,
  RegisterDeviceTokenInput,
  UpdateAddressInput,
  UpdateCustomerProfileInput,
} from '../validation/customer.validation'

const customerUserInclude = {
  addresses: {
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  },
  customerProfile: {
    include: {
      defaultAddress: true,
    },
  },
  _count: {
    select: {
      customerOrders: true,
    },
  },
} satisfies Prisma.UserInclude

type CustomerUser = Prisma.UserGetPayload<{
  include: typeof customerUserInclude
}>

async function getCustomerUser(userId: string): Promise<CustomerUser> {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    include: customerUserInclude,
  })

  if (!user || user.role !== 'CUSTOMER' || !user.customerProfile) {
    throw createHttpError(404, 'Customer profile not found')
  }

  return user
}

/**
 * The same 404 guard as `getCustomerUser`, reading three columns instead of the user's whole
 * address book, profile and order count. Most callers below only need the guard — loading a
 * customer's every address (and counting their every order) to decide whether to 404 is work
 * that grows with the customer's history for no benefit. `getCustomerProfile`, which actually
 * renders all of that, still uses the full version.
 */
async function assertCustomerAccount(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, customerProfile: { select: { id: true } } },
  })

  if (!user || user.role !== 'CUSTOMER' || !user.customerProfile) {
    throw createHttpError(404, 'Customer profile not found')
  }
}

async function setDefaultAddress(
  transaction: Prisma.TransactionClient,
  userId: string,
  addressId: string | null,
): Promise<void> {
  await transaction.address.updateMany({
    where: {
      userId,
    },
    data: {
      isDefault: false,
    },
  })

  if (addressId) {
    await transaction.address.update({
      where: {
        id: addressId,
      },
      data: {
        isDefault: true,
      },
    })
  }

  await transaction.customerProfile.update({
    where: {
      userId,
    },
    data: {
      defaultAddressId: addressId,
    },
  })
}

async function findFallbackAddressId(
  transaction: Prisma.TransactionClient,
  userId: string,
  excludedAddressId?: string,
): Promise<string | null> {
  const fallbackAddress = await transaction.address.findFirst({
    where: {
      userId,
      id: excludedAddressId ? { not: excludedAddressId } : undefined,
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  })

  return fallbackAddress?.id ?? null
}

async function getCustomerProfile(userId: string) {
  const user = await getCustomerUser(userId)

  return {
    item: {
      user: mapSafeUser(user),
      profile: mapCustomerProfile(user.customerProfile!),
      stats: {
        addressCount: user.addresses.length,
        orderCount: user._count.customerOrders,
      },
    },
    meta: buildMeta(),
  }
}

async function updateCustomerProfile(
  userId: string,
  payload: UpdateCustomerProfileInput,
) {
  const currentUser = await getCustomerUser(userId)
  const nextPhone = payload.phone === undefined
    ? currentUser.phone
    : normalizeOptionalString(payload.phone)

  if (nextPhone) {
    const existingUser = await prisma.user.findUnique({
      where: {
        phone: nextPhone,
      },
    })

    if (existingUser && existingUser.id !== userId) {
      throw createHttpError(409, 'This phone number is already linked to another account')
    }
  }

  const updatedUser = await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      fullName: payload.fullName?.trim() ?? currentUser.fullName,
      phone: nextPhone,
    },
    include: {
      customerProfile: {
        include: {
          defaultAddress: true,
        },
      },
    },
  })

  return {
    item: {
      user: mapSafeUser(updatedUser),
      profile: mapCustomerProfile(updatedUser.customerProfile!),
    },
    meta: buildMeta(),
  }
}

async function listCustomerAddresses(userId: string) {
  await assertCustomerAccount(userId)

  const addresses = await prisma.address.findMany({
    where: {
      userId,
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  })

  return {
    items: addresses.map(mapAddress),
    meta: buildMeta({
      total: addresses.length,
    }),
  }
}

async function createCustomerAddress(
  userId: string,
  payload: CreateAddressInput,
) {
  await assertCustomerAccount(userId)

  const address = await prisma.$transaction(async (transaction) => {
    const existingAddressCount = await transaction.address.count({
      where: {
        userId,
      },
    })

    const shouldBeDefault = payload.isDefault || existingAddressCount === 0

    const createdAddress = await transaction.address.create({
      data: {
        userId,
        label: payload.label.trim(),
        fullName: payload.fullName.trim(),
        phone: payload.phone.trim(),
        line1: payload.line1.trim(),
        line2: normalizeOptionalString(payload.line2),
        city: payload.city.trim(),
        area: normalizeOptionalString(payload.area),
        pincode: payload.pincode.trim(),
        landmark: normalizeOptionalString(payload.landmark),
        latitude: payload.latitude ?? null,
        longitude: payload.longitude ?? null,
        isDefault: false,
      },
    })

    if (shouldBeDefault) {
      await setDefaultAddress(transaction, userId, createdAddress.id)
    }

    return transaction.address.findUnique({
      where: {
        id: createdAddress.id,
      },
    })
  })

  return {
    item: mapAddress(address!),
    meta: buildMeta(),
  }
}

async function updateCustomerAddress(
  userId: string,
  addressId: string,
  payload: UpdateAddressInput,
) {
  await assertCustomerAccount(userId)

  const existingAddress = await prisma.address.findFirst({
    where: {
      id: addressId,
      userId,
    },
  })

  if (!existingAddress) {
    throw createHttpError(404, 'Address not found')
  }

  const updatedAddress = await prisma.$transaction(async (transaction) => {
    await transaction.address.update({
      where: {
        id: addressId,
      },
      data: {
        label: payload.label?.trim() ?? existingAddress.label,
        fullName: payload.fullName?.trim() ?? existingAddress.fullName,
        phone: payload.phone?.trim() ?? existingAddress.phone,
        line1: payload.line1?.trim() ?? existingAddress.line1,
        line2:
          payload.line2 === undefined
            ? existingAddress.line2
            : normalizeOptionalString(payload.line2),
        city: payload.city?.trim() ?? existingAddress.city,
        area:
          payload.area === undefined
            ? existingAddress.area
            : normalizeOptionalString(payload.area),
        pincode: payload.pincode?.trim() ?? existingAddress.pincode,
        landmark:
          payload.landmark === undefined
            ? existingAddress.landmark
            : normalizeOptionalString(payload.landmark),
        latitude:
          payload.latitude === undefined
            ? existingAddress.latitude
            : payload.latitude,
        longitude:
          payload.longitude === undefined
            ? existingAddress.longitude
            : payload.longitude,
      },
    })

    if (payload.isDefault === true) {
      await setDefaultAddress(transaction, userId, addressId)
    }

    if (payload.isDefault === false && existingAddress.isDefault) {
      const fallbackAddressId = await findFallbackAddressId(
        transaction,
        userId,
        addressId,
      )

      await setDefaultAddress(transaction, userId, fallbackAddressId)
    }

    return transaction.address.findUnique({
      where: {
        id: addressId,
      },
    })
  })

  return {
    item: mapAddress(updatedAddress!),
    meta: buildMeta(),
  }
}

async function deleteCustomerAddress(userId: string, addressId: string) {
  await assertCustomerAccount(userId)

  const existingAddress = await prisma.address.findFirst({
    where: {
      id: addressId,
      userId,
    },
  })

  if (!existingAddress) {
    throw createHttpError(404, 'Address not found')
  }

  await prisma.$transaction(async (transaction) => {
    await transaction.address.delete({
      where: {
        id: addressId,
      },
    })

    if (existingAddress.isDefault) {
      const fallbackAddressId = await findFallbackAddressId(transaction, userId)
      await setDefaultAddress(transaction, userId, fallbackAddressId)
    }
  })

  return {
    success: true,
    meta: buildMeta(),
  }
}

// A customer's order history only grows. The list renders `mapOrderPreview`'s dozen fields, so
// it reads those columns instead of every column of every order the customer has ever placed
// (which includes the delivery address, notes, driver details and the inventory-sync error blob),
// and it reads one page of them rather than all of them.
const CUSTOMER_ORDERS_DEFAULT_LIMIT = 25
const CUSTOMER_ORDERS_MAX_LIMIT = 100

const ORDER_PREVIEW_SELECT = {
  id: true,
  orderNumber: true,
  customerUserId: true,
  shopId: true,
  shopName: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  totalAmount: true,
  customerName: true,
  placedAt: true,
  deliveredAt: true,
  inventorySalesOrderId: true,
} satisfies Prisma.OrderSelect

async function listCustomerOrders(
  userId: string,
  pagination?: { page?: number | null; limit?: number | null },
) {
  await assertCustomerAccount(userId)

  const limit = Math.min(
    Math.max(pagination?.limit ?? CUSTOMER_ORDERS_DEFAULT_LIMIT, 1),
    CUSTOMER_ORDERS_MAX_LIMIT,
  )
  const page = Math.max(pagination?.page ?? 1, 1)

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: {
        customerUserId: userId,
      },
      select: ORDER_PREVIEW_SELECT,
      orderBy: {
        createdAt: 'desc',
      },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where: { customerUserId: userId } }),
  ])

  // "Action needed — the shop can only supply some of this order." Surfaced on the list as well
  // as the detail screen so a customer doesn't have to open an order to discover it is blocked on
  // them. Bounded and fail-soft (see `loadPartialFulfilmentsForOrderList`): a slow or unreachable
  // bridge costs the badge, never the list.
  const awaitingResponse = await loadPartialFulfilmentsForOrderList(orders)

  return {
    items: orders.map((order) => ({
      ...mapOrderPreview(order),
      // null for everything that isn't waiting on the customer right now — including orders that
      // weren't checked at all because they were outside the lookup budget.
      partialFulfilment: awaitingResponse.get(order.id) ?? null,
    })),
    meta: buildMeta({
      // Unchanged meaning: how many orders this response carries. `matched` is the customer's
      // full history size, for a client that wants to page through it.
      total: orders.length,
      matched: total,
      page,
      limit,
      hasMore: page * limit < total,
    }),
  }
}

async function registerCustomerDeviceToken(
  userId: string,
  payload: RegisterDeviceTokenInput,
) {
  await assertCustomerAccount(userId)

  const deviceToken = await prisma.deviceToken.upsert({
    where: {
      ownerId_expoPushToken: {
        ownerId: userId,
        expoPushToken: payload.expoPushToken,
      },
    },
    update: {
      platform: normalizeOptionalString(payload.platform),
      ownerType: 'CUSTOMER',
    },
    create: {
      ownerId: userId,
      ownerType: 'CUSTOMER',
      expoPushToken: payload.expoPushToken,
      platform: normalizeOptionalString(payload.platform),
    },
  })

  return {
    item: {
      id: deviceToken.id,
      platform: deviceToken.platform,
      createdAt: deviceToken.createdAt,
      updatedAt: deviceToken.updatedAt,
    },
    meta: buildMeta(),
  }
}

export {
  createCustomerAddress,
  deleteCustomerAddress,
  getCustomerProfile,
  listCustomerAddresses,
  listCustomerOrders,
  registerCustomerDeviceToken,
  updateCustomerAddress,
  updateCustomerProfile,
}
