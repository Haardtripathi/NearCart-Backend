import type { Prisma } from '@prisma/client'

import prisma from '../lib/prisma'
import { buildMeta } from '../utils/response'
import {
  mapSafeUser,
  mapShop,
  mapShopOwnerProfile,
} from '../utils/serializers'
import { slugify } from '../utils/slug'
import { createHttpError } from '../utils/httpError'
import { normalizeOptionalString } from '../utils/user'
import type {
  CreateShopInput,
  UpdateShopInput,
  UpdateShopOwnerProfileInput,
} from '../validation/shop-owner.validation'

const shopOwnerUserInclude = {
  shopOwnerProfile: {
    include: {
      shops: true,
    },
  },
} satisfies Prisma.UserInclude

type ShopOwnerUser = Prisma.UserGetPayload<{
  include: typeof shopOwnerUserInclude
}>

type ShopOwnerUserWithProfile = ShopOwnerUser & {
  shopOwnerProfile: NonNullable<ShopOwnerUser['shopOwnerProfile']>
}

async function getShopOwnerUser(
  userId: string,
): Promise<ShopOwnerUserWithProfile> {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    include: shopOwnerUserInclude,
  })

  if (!user || user.role !== 'SHOP_OWNER' || !user.shopOwnerProfile) {
    throw createHttpError(404, 'Shop owner profile not found')
  }

  return user as ShopOwnerUserWithProfile
}

async function ensureUniquePhone(
  phone: string | null,
  userId: string,
): Promise<void> {
  if (!phone) {
    return
  }

  const existingUser = await prisma.user.findUnique({
    where: {
      phone,
    },
  })

  if (existingUser && existingUser.id !== userId) {
    throw createHttpError(409, 'This phone number is already linked to another account')
  }
}

async function ensureUniqueGstNumber(
  gstNumber: string | null,
  profileId: string,
): Promise<void> {
  if (!gstNumber) {
    return
  }

  const existingProfile = await prisma.shopOwnerProfile.findUnique({
    where: {
      gstNumber,
    },
  })

  if (existingProfile && existingProfile.id !== profileId) {
    throw createHttpError(409, 'This GST number is already linked to another shop owner')
  }
}

async function generateUniqueShopSlug(
  name: string,
  excludeShopId?: string,
): Promise<string> {
  const baseSlug = slugify(name) || 'shop'
  let suffix = 0

  while (true) {
    const candidateSlug =
      suffix === 0 ? baseSlug : `${baseSlug}-${String(suffix)}`
    const existingShop = await prisma.shop.findFirst({
      where: {
        slug: candidateSlug,
        id: excludeShopId ? { not: excludeShopId } : undefined,
      },
    })

    if (!existingShop) {
      return candidateSlug
    }

    suffix += 1
  }
}

async function getShopOwnerProfile(userId: string) {
  const user = await getShopOwnerUser(userId)
  const shops = user.shopOwnerProfile.shops

  return {
    item: {
      user: mapSafeUser(user),
      profile: mapShopOwnerProfile(user.shopOwnerProfile!),
      stats: {
        shopCount: shops.length,
        approvedShopCount: shops.filter(
          (shop) => shop.approvalStatus === 'APPROVED',
        ).length,
        pendingShopCount: shops.filter(
          (shop) => shop.approvalStatus === 'PENDING',
        ).length,
      },
    },
    meta: buildMeta(),
  }
}

async function updateShopOwnerProfile(
  userId: string,
  payload: UpdateShopOwnerProfileInput,
) {
  const currentUser = await getShopOwnerUser(userId)
  const nextPhone = payload.phone === undefined
    ? currentUser.phone
    : normalizeOptionalString(payload.phone)
  const nextGstNumber = payload.gstNumber === undefined
    ? currentUser.shopOwnerProfile.gstNumber
    : normalizeOptionalString(payload.gstNumber)

  await ensureUniquePhone(nextPhone, userId)
  await ensureUniqueGstNumber(nextGstNumber, currentUser.shopOwnerProfile.id)

  const updatedUser = await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      fullName: payload.fullName?.trim() ?? currentUser.fullName,
      phone: nextPhone,
      shopOwnerProfile: {
        update: {
          businessName:
            payload.businessName?.trim() ??
            currentUser.shopOwnerProfile.businessName,
          gstNumber: nextGstNumber,
        },
      },
    },
    include: {
      shopOwnerProfile: true,
    },
  })

  return {
    item: {
      user: mapSafeUser(updatedUser),
      profile: mapShopOwnerProfile(updatedUser.shopOwnerProfile!),
    },
    meta: buildMeta(),
  }
}

async function createShop(userId: string, payload: CreateShopInput) {
  const user = await getShopOwnerUser(userId)
  const slug = await generateUniqueShopSlug(payload.name)

  const shop = await prisma.shop.create({
    data: {
      ownerProfileId: user.shopOwnerProfile.id,
      name: payload.name.trim(),
      slug,
      description: normalizeOptionalString(payload.description),
      category: payload.category.trim(),
      phone: payload.phone.trim(),
      email: normalizeOptionalString(payload.email),
      addressLine1: payload.addressLine1.trim(),
      addressLine2: normalizeOptionalString(payload.addressLine2),
      city: payload.city.trim(),
      area: normalizeOptionalString(payload.area),
      pincode: payload.pincode.trim(),
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
      openingTime: normalizeOptionalString(payload.openingTime),
      closingTime: normalizeOptionalString(payload.closingTime),
      memberships: {
        create: {
          ownerProfileId: user.shopOwnerProfile.id,
          role: 'OWNER',
        },
      },
    },
  })

  return {
    item: mapShop(shop),
    meta: buildMeta(),
  }
}

async function listShopOwnerShops(userId: string) {
  const user = await getShopOwnerUser(userId)

  const shops = await prisma.shop.findMany({
    where: {
      ownerProfileId: user.shopOwnerProfile.id,
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  return {
    items: shops.map(mapShop),
    meta: buildMeta({
      total: shops.length,
    }),
  }
}

async function getShopOwnerShop(userId: string, shopId: string) {
  const user = await getShopOwnerUser(userId)

  const shop = await prisma.shop.findFirst({
    where: {
      id: shopId,
      ownerProfileId: user.shopOwnerProfile.id,
    },
  })

  if (!shop) {
    throw createHttpError(404, 'Shop not found')
  }

  return {
    item: mapShop(shop),
    meta: buildMeta(),
  }
}

async function updateShop(
  userId: string,
  shopId: string,
  payload: UpdateShopInput,
) {
  const user = await getShopOwnerUser(userId)

  const existingShop = await prisma.shop.findFirst({
    where: {
      id: shopId,
      ownerProfileId: user.shopOwnerProfile.id,
    },
  })

  if (!existingShop) {
    throw createHttpError(404, 'Shop not found')
  }

  const shop = await prisma.shop.update({
    where: {
      id: shopId,
    },
    data: {
      name: payload.name?.trim() ?? existingShop.name,
      description:
        payload.description === undefined
          ? existingShop.description
          : normalizeOptionalString(payload.description),
      category: payload.category?.trim() ?? existingShop.category,
      phone: payload.phone?.trim() ?? existingShop.phone,
      email:
        payload.email === undefined
          ? existingShop.email
          : normalizeOptionalString(payload.email),
      addressLine1: payload.addressLine1?.trim() ?? existingShop.addressLine1,
      addressLine2:
        payload.addressLine2 === undefined
          ? existingShop.addressLine2
          : normalizeOptionalString(payload.addressLine2),
      city: payload.city?.trim() ?? existingShop.city,
      area:
        payload.area === undefined
          ? existingShop.area
          : normalizeOptionalString(payload.area),
      pincode: payload.pincode?.trim() ?? existingShop.pincode,
      latitude:
        payload.latitude === undefined ? existingShop.latitude : payload.latitude,
      longitude:
        payload.longitude === undefined
          ? existingShop.longitude
          : payload.longitude,
      openingTime:
        payload.openingTime === undefined
          ? existingShop.openingTime
          : normalizeOptionalString(payload.openingTime),
      closingTime:
        payload.closingTime === undefined
          ? existingShop.closingTime
          : normalizeOptionalString(payload.closingTime),
      isActive:
        payload.isActive === undefined ? existingShop.isActive : payload.isActive,
    },
  })

  return {
    item: mapShop(shop),
    meta: buildMeta(),
  }
}

export {
  createShop,
  getShopOwnerProfile,
  getShopOwnerShop,
  listShopOwnerShops,
  updateShop,
  updateShopOwnerProfile,
}
