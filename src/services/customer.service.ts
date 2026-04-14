import type { Prisma } from '@prisma/client'

import prisma from '../lib/prisma'
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
  await getCustomerUser(userId)

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
  await getCustomerUser(userId)

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
  await getCustomerUser(userId)

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
  await getCustomerUser(userId)

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

async function listCustomerOrders(userId: string) {
  await getCustomerUser(userId)

  const orders = await prisma.order.findMany({
    where: {
      customerUserId: userId,
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  return {
    items: orders.map(mapOrderPreview),
    meta: buildMeta({
      total: orders.length,
    }),
  }
}

export {
  createCustomerAddress,
  deleteCustomerAddress,
  getCustomerProfile,
  listCustomerAddresses,
  listCustomerOrders,
  updateCustomerAddress,
  updateCustomerProfile,
}
