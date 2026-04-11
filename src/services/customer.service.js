const prisma = require('../lib/prisma')
const {
  mapAddress,
  mapCustomerProfile,
  mapOrderPreview,
  mapSafeUser,
} = require('../utils/serializers')
const { buildMeta } = require('../utils/response')
const { createHttpError } = require('../utils/httpError')
const { normalizeOptionalString } = require('../utils/user')

async function getCustomerUser(userId) {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    include: {
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
    },
  })

  if (!user || user.role !== 'CUSTOMER' || !user.customerProfile) {
    throw createHttpError(404, 'Customer profile not found')
  }

  return user
}

async function setDefaultAddress(transaction, userId, addressId) {
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

async function findFallbackAddressId(transaction, userId, excludedAddressId) {
  const fallbackAddress = await transaction.address.findFirst({
    where: {
      userId,
      id: excludedAddressId ? { not: excludedAddressId } : undefined,
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
  })

  return fallbackAddress?.id ?? null
}

async function getCustomerProfile(userId) {
  const user = await getCustomerUser(userId)

  return {
    item: {
      user: mapSafeUser(user),
      profile: mapCustomerProfile(user.customerProfile),
      stats: {
        addressCount: user.addresses.length,
        orderCount: user._count.customerOrders,
      },
    },
    meta: buildMeta(),
  }
}

async function updateCustomerProfile(userId, payload) {
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
      profile: mapCustomerProfile(updatedUser.customerProfile),
    },
    meta: buildMeta(),
  }
}

async function listCustomerAddresses(userId) {
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

async function createCustomerAddress(userId, payload) {
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
    item: mapAddress(address),
    meta: buildMeta(),
  }
}

async function updateCustomerAddress(userId, addressId, payload) {
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
    item: mapAddress(updatedAddress),
    meta: buildMeta(),
  }
}

async function deleteCustomerAddress(userId, addressId) {
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

async function listCustomerOrders(userId) {
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

module.exports = {
  createCustomerAddress,
  deleteCustomerAddress,
  getCustomerProfile,
  listCustomerAddresses,
  listCustomerOrders,
  updateCustomerAddress,
  updateCustomerProfile,
}
