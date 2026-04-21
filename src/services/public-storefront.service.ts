import type { Shop } from '@prisma/client'

import prisma from '../lib/prisma'
import {
  checkInventoryAvailability,
  getInventoryCatalogProduct,
  listInventoryCatalog,
  listInventoryMarketplaceOrganizations,
  type InventoryAvailabilityResponse,
  type InventoryCatalogItem,
} from './inventory-client.service'
import { createHttpError } from '../utils/httpError'
import type {
  CartValidationItemInput,
  PublicCartValidationInput,
  ShopCatalogQueryInput,
} from '../validation/public.validation'

const PUBLIC_SHOP_WHERE = {
  approvalStatus: 'APPROVED' as const,
  isActive: true,
  publicCatalogEnabled: true,
}

function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }

  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/)

  if (!match) {
    return null
  }

  const hours = Number.parseInt(match[1] ?? '', 10)
  const minutes = Number.parseInt(match[2] ?? '', 10)

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null
  }

  return hours * 60 + minutes
}

function isShopOpenNow(shop: Shop): boolean | null {
  const openingMinutes = parseTimeToMinutes(shop.openingTime)
  const closingMinutes = parseTimeToMinutes(shop.closingTime)

  if (openingMinutes == null || closingMinutes == null) {
    return null
  }

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())

  const currentHour = Number.parseInt(
    parts.find((part) => part.type === 'hour')?.value ?? '0',
    10,
  )
  const currentMinute = Number.parseInt(
    parts.find((part) => part.type === 'minute')?.value ?? '0',
    10,
  )
  const currentMinutes = currentHour * 60 + currentMinute

  if (closingMinutes < openingMinutes) {
    return currentMinutes >= openingMinutes || currentMinutes <= closingMinutes
  }

  return currentMinutes >= openingMinutes && currentMinutes <= closingMinutes
}

async function getMappedPublicShop(shopIdOrSlug: string) {
  const shop = await prisma.shop.findFirst({
    where: {
      ...PUBLIC_SHOP_WHERE,
      OR: [{ id: shopIdOrSlug }, { slug: shopIdOrSlug }],
    },
  })

  if (!shop) {
    throw createHttpError(404, 'Public shop not found')
  }

  if (!shop.inventoryOrganizationId || !shop.inventoryBranchId) {
    throw createHttpError(
      409,
      'This shop is approved but not mapped to a live inventory source yet.',
    )
  }

  return shop
}

function mapPublicShopSummary(shop: Shop) {
  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    category: shop.category,
    description: shop.description,
    city: shop.city,
    area: shop.area,
    logoImageUrl: shop.logoImageUrl,
    estimatedDeliveryMinutes: shop.estimatedDeliveryMinutes,
    minimumOrderAmount: shop.minimumOrderAmount,
    deliveryFee: shop.deliveryFeeDefault,
    deliveryEnabled: shop.deliveryEnabled,
    isOpenNow: isShopOpenNow(shop),
  }
}

function mapPublicShopDetail(shop: Shop) {
  return {
    ...mapPublicShopSummary(shop),
    phone: shop.phone,
    email: shop.email,
    addressLine1: shop.addressLine1,
    addressLine2: shop.addressLine2,
    pincode: shop.pincode,
    openingTime: shop.openingTime,
    closingTime: shop.closingTime,
    serviceRadiusKm: shop.serviceRadiusKm,
  }
}

function mapCatalogItemForPublicApi(item: InventoryCatalogItem) {
  return {
    id: item.id,
    variantId: item.primaryVariantId,
    slug: item.slug,
    name: item.name,
    description: item.description,
    image: item.imageUrl,
    category: item.category,
    brand: item.brand,
    price: item.price,
    mrp: item.mrp,
    stockStatus: item.stockStatus,
    availableQty: item.availableQty,
    isAvailable: item.isAvailable,
    unitLabel: item.unitLabel,
    hasVariants: item.hasVariants,
    variantCount: item.variantCount,
    translations: item.translations ?? {},
    variants: item.variants ?? [],
  }
}

function mapAvailabilityItem(
  shop: Shop,
  item: InventoryAvailabilityResponse['items'][number],
  inputItem: CartValidationItemInput,
) {
  const product = item.product

  if (!product) {
    return {
      productId: item.productId,
      variantId: item.variantId,
      requestedQuantity: inputItem.quantity,
      quantityAccepted: item.quantityAccepted,
      availableQty: item.availableQuantity,
      status: item.status,
      stockStatus: item.stockStatus,
      reason: item.reason,
      price: item.price,
      mrp: item.mrp,
    }
  }

  return {
    productId: product.id,
    variantId: item.variantId,
    shopId: shop.id,
    shopName: shop.name,
    name: product.name,
    description: product.description,
    image: product.imageUrl,
    category: product.category,
    brand: product.brand,
    unitLabel: product.unitLabel,
    requestedQuantity: inputItem.quantity,
    quantityAccepted: item.quantityAccepted,
    availableQty: item.availableQuantity,
    stockStatus: item.stockStatus,
    status: item.status,
    reason: item.reason,
    price: item.price,
    mrp: item.mrp,
    translations: product.translations ?? {},
  }
}

async function buildValidatedCartSnapshot(
  payload: PublicCartValidationInput,
) {
  const shop = await getMappedPublicShop(payload.shopId)
  const inventoryResult = await checkInventoryAvailability({
    organizationId: shop.inventoryOrganizationId!,
    branchId: shop.inventoryBranchId!,
    language: payload.lang,
    items: payload.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId || null,
      quantity: item.quantity,
    })),
  })

  const validItems: Array<ReturnType<typeof mapAvailabilityItem>> = []
  const invalidItems: Array<ReturnType<typeof mapAvailabilityItem>> = []
  const outOfStockItems: Array<ReturnType<typeof mapAvailabilityItem>> = []
  const changedPriceItems: Array<
    ReturnType<typeof mapAvailabilityItem> & {
      expectedPrice: number | undefined
      expectedMrp: number | null | undefined
    }
  > = []
  const appliedItems: Array<
    ReturnType<typeof mapAvailabilityItem> & {
      quantity: number
    }
  > = []

  inventoryResult.items.forEach((item, index) => {
    const inputItem = payload.items[index]
    const normalizedItem = mapAvailabilityItem(shop, item, inputItem)
    const priceChanged =
      inputItem.expectedPrice !== undefined &&
      normalizedItem.price !== null &&
      inputItem.expectedPrice !== normalizedItem.price
    const mrpChanged =
      inputItem.expectedMrp !== undefined &&
      (inputItem.expectedMrp ?? null) !== (normalizedItem.mrp ?? null)

    if (priceChanged || mrpChanged) {
      changedPriceItems.push({
        ...normalizedItem,
        expectedPrice: inputItem.expectedPrice,
        expectedMrp: inputItem.expectedMrp,
      })
    }

    if (item.quantityAccepted > 0 && item.product && item.price !== null) {
      appliedItems.push({
        ...normalizedItem,
        quantity: item.quantityAccepted,
      })
    }

    if (item.status === 'VALID') {
      validItems.push(normalizedItem)
      return
    }

    if (item.status === 'NOT_FOUND') {
      invalidItems.push(normalizedItem)
      return
    }

    outOfStockItems.push(normalizedItem)
  })

  const subtotal = appliedItems.reduce(
    (total, item) => total + (item.price ?? 0) * item.quantity,
    0,
  )
  const deliveryFee = shop.deliveryEnabled ? shop.deliveryFeeDefault : 0
  const totalAmount = subtotal + deliveryFee

  return {
    shop,
    validItems,
    invalidItems,
    outOfStockItems,
    changedPriceItems,
    appliedItems,
    summary: {
      currencyCode: inventoryResult.shopInventory.organization.currencyCode,
      subtotal,
      deliveryFee,
      totalAmount,
      itemCount: appliedItems.reduce((total, item) => total + item.quantity, 0),
      validCount: validItems.length,
      invalidCount: invalidItems.length,
      outOfStockCount: outOfStockItems.length,
      changedPriceCount: changedPriceItems.length,
    },
    inventory: inventoryResult.shopInventory,
  }
}

async function listPublicShops() {
  const shops = await prisma.shop.findMany({
    where: {
      ...PUBLIC_SHOP_WHERE,
      inventoryOrganizationId: {
        not: null,
      },
      inventoryBranchId: {
        not: null,
      },
    },
    orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
  })

  return {
    items: shops.map(mapPublicShopSummary),
    meta: {
      total: shops.length,
    },
  }
}

async function getPublicShop(shopIdOrSlug: string) {
  const shop = await getMappedPublicShop(shopIdOrSlug)

  return {
    item: mapPublicShopDetail(shop),
  }
}

async function listPublicShopCatalog(
  shopIdOrSlug: string,
  query: ShopCatalogQueryInput,
) {
  const shop = await getMappedPublicShop(shopIdOrSlug)
  const catalog = await listInventoryCatalog({
    organizationId: shop.inventoryOrganizationId!,
    branchId: shop.inventoryBranchId!,
    search: query.search,
    category: query.category,
    brand: query.brand,
    inStockOnly: query.inStockOnly,
    page: query.page,
    limit: query.limit,
    sort: query.sort,
    language: query.lang,
  })

  return {
    item: mapPublicShopDetail(shop),
    items: catalog.items.map(mapCatalogItemForPublicApi),
    filters: catalog.filters,
    pagination: catalog.pagination,
    inventory: catalog.shopInventory,
  }
}

async function getPublicCatalogProduct(
  shopIdOrSlug: string,
  productId: string,
  language?: string | null,
) {
  const shop = await getMappedPublicShop(shopIdOrSlug)
  const product = await getInventoryCatalogProduct({
    organizationId: shop.inventoryOrganizationId!,
    branchId: shop.inventoryBranchId!,
    productId,
    language,
  })

  return {
    shop: mapPublicShopDetail(shop),
    item: mapCatalogItemForPublicApi(product.item),
    inventory: product.shopInventory,
  }
}

async function validatePublicCart(payload: PublicCartValidationInput) {
  const snapshot = await buildValidatedCartSnapshot(payload)

  return {
    item: {
      shop: mapPublicShopDetail(snapshot.shop),
      validItems: snapshot.validItems,
      invalidItems: snapshot.invalidItems,
      outOfStockItems: snapshot.outOfStockItems,
      changedPriceItems: snapshot.changedPriceItems,
      appliedItems: snapshot.appliedItems,
      summary: snapshot.summary,
      inventory: snapshot.inventory,
    },
  }
}

async function getAuthoritativeCheckoutSnapshot(payload: {
  shopId: string
  items: Array<{
    productId: string
    variantId?: string | null
    quantity: number
  }>
  lang?: string | null
}) {
  const snapshot = await buildValidatedCartSnapshot({
    shopId: payload.shopId,
    lang: payload.lang ?? undefined,
    items: payload.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId ?? undefined,
      quantity: item.quantity,
    })),
  })

  if (snapshot.invalidItems.length > 0 || snapshot.outOfStockItems.length > 0) {
    throw createHttpError(400, 'Some cart items are no longer purchasable.', {
      validation: {
        invalidItems: snapshot.invalidItems,
        outOfStockItems: snapshot.outOfStockItems,
        changedPriceItems: snapshot.changedPriceItems,
        appliedItems: snapshot.appliedItems,
        summary: snapshot.summary,
      },
    })
  }

  return snapshot
}

async function listInventoryMappingOptions(search?: string | null) {
  return listInventoryMarketplaceOrganizations(search)
}

export {
  getAuthoritativeCheckoutSnapshot,
  getMappedPublicShop,
  getPublicCatalogProduct,
  getPublicShop,
  listInventoryMappingOptions,
  listPublicShopCatalog,
  listPublicShops,
  validatePublicCart,
}
