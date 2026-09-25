/**
 * Service-to-service variant of the shop owner's daily "open today" confirmation (see
 * `shop-owner.service.ts`'s `updateShopTodayStatus` + `utils/shop-availability.ts`).
 *
 * Real shop owners run their shop from the NearCart-Inventory "Partner" app, which only ever
 * talks to the Inventory backend — so Inventory proxies the switch here, addressing the shop by
 * the Inventory organization (and optionally branch) it's linked to rather than by NearCart's own
 * shop id / owner login. Authorisation (who in the org may flip it) is Inventory's job; this side
 * only trusts the shared internal token (`requireInternalServiceAuth`).
 */

import type { Prisma, Shop } from '@prisma/client'

import prisma from '../lib/prisma'
import { bumpShopDirectoryGeneration } from '../lib/cache'
import { createHttpError } from '../utils/httpError'
import { getShopTodayStatus } from '../utils/shop-availability'
import { buildShopTodayStatusData } from './shop-owner.service'

interface InternalShopScope {
  organizationId: string
  branchId?: string | undefined
}

interface InternalUpdateShopTodayStatusInput extends InternalShopScope {
  isOpen: boolean
  reason?: string | undefined
}

// A shop linked to the org with NO specific branch is the org's one storefront, so a
// branch-narrowed call still includes it — otherwise a Partner-app user with a branch filter
// active would be told "not listed" about a shop that plainly is.
function buildLinkedShopWhere(scope: InternalShopScope): Prisma.ShopWhereInput {
  return {
    inventoryOrganizationId: scope.organizationId,
    ...(scope.branchId
      ? { OR: [{ inventoryBranchId: scope.branchId }, { inventoryBranchId: null }] }
      : {}),
  }
}

function mapShopTodayStatusItem(shop: Shop) {
  return {
    shopId: shop.id,
    name: shop.name,
    slug: shop.slug,
    inventoryBranchId: shop.inventoryBranchId,
    todayStatus: getShopTodayStatus(shop),
    isOpenToday: shop.isOpenToday,
    todayStatusReason: shop.todayStatusReason,
    todayStatusUpdatedAt: shop.todayStatusUpdatedAt,
    openingTime: shop.openingTime,
    closingTime: shop.closingTime,
  }
}

async function findLinkedShops(scope: InternalShopScope): Promise<Shop[]> {
  return prisma.shop.findMany({
    where: buildLinkedShopWhere(scope),
    orderBy: { createdAt: 'asc' },
  })
}

async function listLinkedShopsTodayStatus(scope: InternalShopScope) {
  const shops = await findLinkedShops(scope)

  return { items: shops.map(mapShopTodayStatusItem) }
}

async function updateLinkedShopsTodayStatus(payload: InternalUpdateShopTodayStatusInput) {
  const shops = await findLinkedShops(payload)

  if (shops.length === 0) {
    throw createHttpError(
      404,
      payload.branchId
        ? 'No NearCart shop is linked to this inventory organization and branch'
        : 'No NearCart shop is linked to this inventory organization',
      { code: 'SHOP_NOT_LINKED' },
    )
  }

  const shopIds = shops.map((shop) => shop.id)

  // One `data` object for every matched shop so they all carry the identical timestamp.
  await prisma.shop.updateMany({
    where: { id: { in: shopIds } },
    data: buildShopTodayStatusData(payload),
  })

  // Same reason as the shop owner's own switch: today's flag is on every public shop card.
  bumpShopDirectoryGeneration()

  const updatedShops = await prisma.shop.findMany({
    where: { id: { in: shopIds } },
    orderBy: { createdAt: 'asc' },
  })

  return { items: updatedShops.map(mapShopTodayStatusItem) }
}

export { listLinkedShopsTodayStatus, updateLinkedShopsTodayStatus }
export type { InternalShopScope, InternalUpdateShopTodayStatusInput }
