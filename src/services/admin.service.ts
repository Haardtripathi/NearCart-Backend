import type { Prisma } from '@prisma/client'

import prisma from '../lib/prisma'
import { bumpShopDirectoryGeneration } from '../lib/cache'
import { listInventoryMappingOptions } from './public-storefront.service'
import { buildMeta } from '../utils/response'
import {
  mapOrderPreview,
  mapSafeUser,
  mapShop,
  mapShopOwnerProfile,
} from '../utils/serializers'
import { createHttpError } from '../utils/httpError'
import { normalizeOptionalString } from '../utils/user'
import type {
  UpdateShopApprovalInput,
  UpdateShopStorefrontInput,
} from '../validation/admin.validation'
import type { PaginationQueryInput } from '../validation/pagination.validation'

/**
 * Every list below used to read its whole table — every user, every shop, every order ever
 * placed — into one response. They paginate now. `meta.total` stays the count of ALL matching
 * rows (which is what the admin dashboard's headline counters read), and `meta.returned` says
 * how many this page carries.
 *
 * The default is deliberately large: nothing an admin screen renders today is truncated by it,
 * and the point is the ceiling, not the page size.
 */
const ADMIN_LIST_DEFAULT_LIMIT = 50
const ADMIN_LIST_MAX_LIMIT = 200

function resolveAdminPagination(pagination?: PaginationQueryInput): {
  skip: number
  take: number
  page: number
  limit: number
} {
  const limit = Math.min(
    Math.max(pagination?.limit ?? ADMIN_LIST_DEFAULT_LIMIT, 1),
    ADMIN_LIST_MAX_LIMIT,
  )
  const page = Math.max(pagination?.page ?? 1, 1)

  return { skip: (page - 1) * limit, take: limit, page, limit }
}

function buildListMeta(
  total: number,
  returned: number,
  page: number,
  limit: number,
  extra?: Record<string, unknown>,
) {
  return buildMeta({
    total,
    returned,
    page,
    limit,
    hasMore: page * limit < total,
    ...(extra ?? {}),
  })
}

async function listUsers(pagination?: PaginationQueryInput) {
  const { skip, take, page, limit } = resolveAdminPagination(pagination)

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take,
      include: {
        shopOwnerProfile: true,
        customerProfile: true,
        _count: {
          select: {
            customerOrders: true,
            addresses: true,
          },
        },
      },
    }),
    prisma.user.count(),
  ])

  return {
    items: users.map((user) => ({
      ...mapSafeUser(user),
      businessName: user.shopOwnerProfile?.businessName ?? null,
      shopOwnerApproved: user.shopOwnerProfile?.isApproved ?? null,
      orderCount: user._count.customerOrders,
      addressCount: user._count.addresses,
    })),
    meta: buildListMeta(total, users.length, page, limit),
  }
}

// `mapSafeUser` reads the user's `customerProfile` only to surface its id and defaultAddressId,
// and a shop owner's user row never has one (registration creates exactly one profile per user,
// and no code path adds the other later — verified against the live database too). So that join
// is dropped here: `customerProfileId`/`defaultAddressId` serialize as null either way.
const SHOP_OWNER_INCLUDE = {
  ownerProfile: {
    include: {
      user: {
        include: {
          shopOwnerProfile: true,
        },
      },
    },
  },
} satisfies Prisma.ShopInclude

async function listPendingShopApprovals(pagination?: PaginationQueryInput) {
  const { skip, take, page, limit } = resolveAdminPagination(pagination)
  const where: Prisma.ShopWhereInput = { approvalStatus: 'PENDING' }

  const [shops, total] = await Promise.all([
    prisma.shop.findMany({
      where,
      orderBy: {
        createdAt: 'asc',
      },
      skip,
      take,
      include: SHOP_OWNER_INCLUDE,
    }),
    prisma.shop.count({ where }),
  ])

  return {
    items: shops.map((shop) => ({
      shop: mapShop(shop),
      owner: {
        user: mapSafeUser(shop.ownerProfile.user),
        profile: mapShopOwnerProfile(shop.ownerProfile),
      },
    })),
    meta: buildListMeta(total, shops.length, page, limit),
  }
}

async function updateShopApproval(
  shopId: string,
  approvalStatus: UpdateShopApprovalInput['approvalStatus'],
) {
  const existingShop = await prisma.shop.findUnique({
    where: {
      id: shopId,
    },
    include: {
      ownerProfile: true,
    },
  })

  if (!existingShop) {
    throw createHttpError(404, 'Shop not found')
  }

  const updatedShop = await prisma.$transaction(async (transaction) => {
    const shop = await transaction.shop.update({
      where: {
        id: shopId,
      },
      data: {
        approvalStatus,
      },
    })

    const approvedShopCount = await transaction.shop.count({
      where: {
        ownerProfileId: existingShop.ownerProfileId,
        approvalStatus: 'APPROVED',
      },
    })

    await transaction.shopOwnerProfile.update({
      where: {
        id: existingShop.ownerProfileId,
      },
      data: {
        isApproved: approvedShopCount > 0,
      },
    })

    return shop
  })

  // Approving/rejecting a shop changes who is publicly listed.
  bumpShopDirectoryGeneration()

  return {
    item: mapShop(updatedShop),
    meta: buildMeta(),
  }
}

async function listShops(pagination?: PaginationQueryInput) {
  const { skip, take, page, limit } = resolveAdminPagination(pagination)

  const [shops, total, pendingCount] = await Promise.all([
    prisma.shop.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take,
      include: SHOP_OWNER_INCLUDE,
    }),
    prisma.shop.count(),
    // Counted in SQL rather than by filtering the loaded page, which would only ever have
    // counted the pending shops that happened to land on this page.
    prisma.shop.count({ where: { approvalStatus: 'PENDING' } }),
  ])

  return {
    items: shops.map((shop) => ({
      ...mapShop(shop),
      inventoryMappingStatus:
        shop.inventoryOrganizationId && shop.inventoryBranchId
          ? 'MAPPED'
          : 'UNMAPPED',
      owner: {
        user: mapSafeUser(shop.ownerProfile.user),
        profile: mapShopOwnerProfile(shop.ownerProfile),
      },
    })),
    meta: buildListMeta(total, shops.length, page, limit, { pendingCount }),
  }
}

async function listInventoryOrganizations(search?: string | null) {
  const result = await listInventoryMappingOptions(search)

  return {
    ...result,
    meta: buildMeta({
      total: result.items.length,
    }),
  }
}

async function updateShopStorefront(
  shopId: string,
  payload: UpdateShopStorefrontInput,
) {
  const existingShop = await prisma.shop.findUnique({
    where: {
      id: shopId,
    },
  })

  if (!existingShop) {
    throw createHttpError(404, 'Shop not found')
  }

  const updatedShop = await prisma.shop.update({
    where: {
      id: shopId,
    },
    data: {
      inventoryOrganizationId: payload.inventoryOrganizationId.trim(),
      inventoryBranchId: payload.inventoryBranchId.trim(),
      publicCatalogEnabled: payload.publicCatalogEnabled,
      logoImageUrl: normalizeOptionalString(payload.logoImageUrl),
    },
  })

  bumpShopDirectoryGeneration()

  return {
    item: mapShop(updatedShop),
    meta: buildMeta(),
  }
}

// The admin order list renders a row summary, not an order — no items, no delivery address, no
// driver details, no inventory-sync error blob.
const ADMIN_ORDER_SELECT = {
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
  customerEmail: true,
  customerPhone: true,
  deliveryFee: true,
  platformFee: true,
  subtotal: true,
} satisfies Prisma.OrderSelect

async function listOrders(pagination?: PaginationQueryInput) {
  const { skip, take, page, limit } = resolveAdminPagination(pagination)

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take,
      select: ADMIN_ORDER_SELECT,
    }),
    prisma.order.count(),
  ])

  return {
    items: orders.map((order) => ({
      ...mapOrderPreview(order),
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      deliveryFee: order.deliveryFee,
      platformFee: order.platformFee,
      subtotal: order.subtotal,
    })),
    meta: buildListMeta(total, orders.length, page, limit),
  }
}

export {
  listOrders,
  listInventoryOrganizations,
  listPendingShopApprovals,
  listShops,
  listUsers,
  updateShopApproval,
  updateShopStorefront,
}
