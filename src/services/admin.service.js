const prisma = require('../lib/prisma')
const {
  mapOrderPreview,
  mapSafeUser,
  mapShop,
  mapShopOwnerProfile,
} = require('../utils/serializers')
const { buildMeta } = require('../utils/response')
const { createHttpError } = require('../utils/httpError')

async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: {
      createdAt: 'desc',
    },
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
  })

  return {
    items: users.map((user) => ({
      ...mapSafeUser(user),
      businessName: user.shopOwnerProfile?.businessName ?? null,
      shopOwnerApproved: user.shopOwnerProfile?.isApproved ?? null,
      orderCount: user._count.customerOrders,
      addressCount: user._count.addresses,
    })),
    meta: buildMeta({
      total: users.length,
    }),
  }
}

async function listPendingShopApprovals() {
  const shops = await prisma.shop.findMany({
    where: {
      approvalStatus: 'PENDING',
    },
    orderBy: {
      createdAt: 'asc',
    },
    include: {
      ownerProfile: {
        include: {
          user: {
            include: {
              customerProfile: true,
              shopOwnerProfile: true,
            },
          },
        },
      },
    },
  })

  return {
    items: shops.map((shop) => ({
      shop: mapShop(shop),
      owner: {
        user: mapSafeUser(shop.ownerProfile.user),
        profile: mapShopOwnerProfile(shop.ownerProfile),
      },
    })),
    meta: buildMeta({
      total: shops.length,
    }),
  }
}

async function updateShopApproval(shopId, approvalStatus) {
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

  return {
    item: mapShop(updatedShop),
    meta: buildMeta(),
  }
}

async function listShops() {
  const shops = await prisma.shop.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    include: {
      ownerProfile: {
        include: {
          user: {
            include: {
              customerProfile: true,
              shopOwnerProfile: true,
            },
          },
        },
      },
    },
  })

  return {
    items: shops.map((shop) => ({
      ...mapShop(shop),
      owner: {
        user: mapSafeUser(shop.ownerProfile.user),
        profile: mapShopOwnerProfile(shop.ownerProfile),
      },
    })),
    meta: buildMeta({
      total: shops.length,
      pendingCount: shops.filter((shop) => shop.approvalStatus === 'PENDING').length,
    }),
  }
}

async function listOrders() {
  const orders = await prisma.order.findMany({
    orderBy: {
      createdAt: 'desc',
    },
  })

  return {
    items: orders.map((order) => ({
      ...mapOrderPreview(order),
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      deliveryFee: order.deliveryFee,
      platformFee: order.platformFee,
      subtotal: order.subtotal,
    })),
    meta: buildMeta({
      total: orders.length,
    }),
  }
}

module.exports = {
  listOrders,
  listPendingShopApprovals,
  listShops,
  listUsers,
  updateShopApproval,
}
