import type { Shop } from '@prisma/client'

import prisma from '../lib/prisma'
import { getDeliveryEtaMinutes } from './delivery-eta.service'
import {
  checkInventoryAvailability,
  getInventoryCatalogProduct,
  listInventoryCatalog,
  listInventoryMarketplaceOrganizations,
  type InventoryAvailabilityResponse,
  type InventoryCatalogItem,
  type InventoryCatalogResponse,
} from './inventory-client.service'
import { createHttpError } from '../utils/httpError'
import type {
  CartValidationItemInput,
  PublicCartValidationInput,
  ShopCatalogQueryInput,
} from '../validation/public.validation'

interface CustomerCoordinates {
  latitude: number
  longitude: number
}

const PUBLIC_SHOP_WHERE = {
  approvalStatus: 'APPROVED' as const,
  isActive: true,
  publicCatalogEnabled: true,
}

// Shared with listPublicShops and the search/trending fan-out below — a shop is only
// eligible for any customer-facing browsing surface once it's both approved/active/
// storefront-enabled AND actually mapped to a live inventory org+branch (getMappedPublicShop
// enforces the same pair of conditions one-shop-at-a-time via a 409; this is the list-level
// equivalent so unmapped shops never appear as fan-out candidates in the first place).
const PUBLIC_MAPPED_SHOP_WHERE = {
  ...PUBLIC_SHOP_WHERE,
  inventoryOrganizationId: { not: null },
  inventoryBranchId: { not: null },
}

// v1 bounded-fan-out tuning — see searchPublicCatalog/listTrendingProducts. No cross-shop
// search index exists; this trades completeness for a hard ceiling on concurrent outbound
// calls to the NearCart-Inventory bridge per customer request.
const SEARCH_FANOUT_SHOP_CAP = 15
const SEARCH_PER_SHOP_RESULT_CAP = 8
const TRENDING_FANOUT_SHOP_CAP = 10
const TRENDING_PER_SHOP_RESULT_CAP = 6

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

/**
 * Attaches the live, computed `liveEstimatedDeliveryMinutes` field to a
 * mapped public shop summary/detail object.
 *
 * `latitude`/`longitude` deliberately stay stripped from the public
 * response (see `mapPublicShopSummary`/`mapPublicShopDetail` above) — the
 * distance math happens here, server-side, against the shop's real
 * `Shop.latitude/longitude` columns before they're discarded.
 *
 * Tradeoff (list vs. detail granularity): a shop-list render can be many
 * shops at once, and both the live weather lookup and the live
 * active-order-count bridge call are one external HTTP request *per shop*.
 * Paying that cost per shop on every list render doesn't scale and isn't
 * worth the precision gain for a scannable list, so `listPublicShops` uses
 * `mode: 'fast'` (distance still computed live if customer coordinates are
 * known; weather/queue fall back to defaults, no external calls). A single
 * shop's detail view (`getPublicShop`, plus the catalog/product detail
 * views which also render shop info) always uses `mode: 'full'` and pays
 * for the live weather + live queue figures, since there's only one shop
 * involved.
 */
async function attachLiveEta<T extends Record<string, unknown>>(
  shop: Shop,
  mapped: T,
  customerCoordinates: CustomerCoordinates | null | undefined,
  mode: 'fast' | 'full',
): Promise<T & { liveEstimatedDeliveryMinutes: number }> {
  const eta = await getDeliveryEtaMinutes({
    shop,
    customerLatitude: customerCoordinates?.latitude ?? null,
    customerLongitude: customerCoordinates?.longitude ?? null,
    mode,
  })

  return {
    ...mapped,
    liveEstimatedDeliveryMinutes: eta.etaMinutes,
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

async function listPublicShops(
  customerCoordinates?: CustomerCoordinates | null,
  filters?: { search?: string | null; category?: string | null },
) {
  const shops = await prisma.shop.findMany({
    where: {
      ...PUBLIC_MAPPED_SHOP_WHERE,
      // Plain `contains`, deliberately no `mode: 'insensitive'` — this schema's datasource is
      // sqlite (see prisma/schema.prisma), which throws a PrismaClientValidationError on that
      // filter (postgres/mysql-only). SQLite's LIKE is already ASCII-case-insensitive, which
      // covers the realistic case of English shop names without it.
      ...(filters?.search ? { name: { contains: filters.search } } : {}),
      ...(filters?.category ? { category: filters.category } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
  })

  const items = await Promise.all(
    shops.map((shop) =>
      attachLiveEta(shop, mapPublicShopSummary(shop), customerCoordinates, 'fast'),
    ),
  )

  return {
    items,
    meta: {
      total: shops.length,
    },
  }
}

// Cheap local aggregation over the flat Shop.category string (shop-type: "Grocery",
// "Pharmacy", ...) — deliberately NOT the deeper per-shop product-category system from the
// inventory bridge (that stays scoped to listPublicShopCatalog's `filters.categories`, unchanged).
// Powers a home-page "browse by shop type" strip, Swiggy/Blinkit-style.
async function listPublicShopCategories() {
  const grouped = await prisma.shop.groupBy({
    by: ['category'],
    where: PUBLIC_MAPPED_SHOP_WHERE,
    _count: { category: true },
    orderBy: { _count: { category: 'desc' } },
  })

  return {
    items: grouped.map((row) => ({
      category: row.category,
      shopCount: row._count.category,
    })),
  }
}

async function fetchCandidateShops(
  filters: { category?: string | null } | undefined,
  take: number,
): Promise<Shop[]> {
  return prisma.shop.findMany({
    where: {
      ...PUBLIC_MAPPED_SHOP_WHERE,
      ...(filters?.category ? { category: filters.category } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
    take,
  })
}

interface FannedOutShopCatalog {
  shop: Shop
  items: InventoryCatalogItem[]
}

// Queries N shops' inventory-bridge catalogs in parallel and keeps only the ones that
// answered. Promise.allSettled (not Promise.all) is deliberate: this hits N independent
// remote services, and one shop's bridge being slow/down must not fail the whole request.
async function fanOutCatalogAcrossShops(
  shops: Shop[],
  buildParams: (shop: Shop) => Parameters<typeof listInventoryCatalog>[0],
): Promise<FannedOutShopCatalog[]> {
  const settled = await Promise.allSettled(
    shops.map(async (shop) => ({
      shop,
      catalog: await listInventoryCatalog(buildParams(shop)),
    })),
  )

  return settled
    .filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        shop: Shop
        catalog: InventoryCatalogResponse
      }> => result.status === 'fulfilled',
    )
    .map((result) => ({ shop: result.value.shop, items: result.value.catalog.items }))
}

// Round-robin interleave across shop groups (take item 0 from every shop, then item 1 from
// every shop, ...) rather than concatenating, so results aren't dominated by whichever shop
// happens to have the largest catalog.
function interleaveShopResults(
  groups: FannedOutShopCatalog[],
  limit: number,
): Array<{ shop: Shop; item: InventoryCatalogItem }> {
  const merged: Array<{ shop: Shop; item: InventoryCatalogItem }> = []
  let index = 0
  let addedInLastPass = true

  while (merged.length < limit && addedInLastPass) {
    addedInLastPass = false

    for (const group of groups) {
      if (merged.length >= limit) {
        break
      }

      const item = group.items[index]

      if (item) {
        merged.push({ shop: group.shop, item })
        addedInLastPass = true
      }
    }

    index += 1
  }

  return merged
}

function mapCatalogItemForSearchResult(shop: Shop, item: InventoryCatalogItem) {
  return {
    ...mapCatalogItemForPublicApi(item),
    shop: mapPublicShopSummary(shop),
  }
}

// v1 cross-shop search — a bounded parallel fan-out over the existing per-shop catalog
// endpoint, not real search infrastructure (no cross-shop index exists). `meta.strategy`
// documents this in the API response itself, not just here, so it isn't mistaken for
// something more sophisticated later. `category` here filters candidate *shops* by
// Shop.category (shop-type), not product category — easy to misread, so stated explicitly.
async function searchPublicCatalog(
  query: string,
  options?: { category?: string | null; limit?: number; language?: string | null },
) {
  const limit = options?.limit ?? 24
  const candidateShops = await fetchCandidateShops(
    { category: options?.category },
    SEARCH_FANOUT_SHOP_CAP,
  )
  const groups = await fanOutCatalogAcrossShops(candidateShops, (shop) => ({
    organizationId: shop.inventoryOrganizationId!,
    branchId: shop.inventoryBranchId!,
    search: query,
    inStockOnly: true,
    sort: 'featured',
    page: 1,
    limit: SEARCH_PER_SHOP_RESULT_CAP,
    language: options?.language,
  }))
  const merged = interleaveShopResults(groups, limit)

  return {
    items: merged.map(({ shop, item }) => mapCatalogItemForSearchResult(shop, item)),
    meta: {
      query,
      shopsSearched: candidateShops.length,
      shopsSucceeded: groups.length,
      shopsFailed: candidateShops.length - groups.length,
      strategy: 'bounded-parallel-fanout-v1',
    },
  }
}

// v1 "trending" — no analytics/order-count table exists anywhere in this schema, so this is
// explicitly featured, in-stock items from a capped set of shops, NOT a real popularity
// ranking. `meta.strategy` says so in the response itself.
async function listTrendingProducts(options?: {
  category?: string | null
  limit?: number
  language?: string | null
}) {
  const limit = options?.limit ?? 20
  const candidateShops = await fetchCandidateShops(
    { category: options?.category },
    TRENDING_FANOUT_SHOP_CAP,
  )
  const groups = await fanOutCatalogAcrossShops(candidateShops, (shop) => ({
    organizationId: shop.inventoryOrganizationId!,
    branchId: shop.inventoryBranchId!,
    inStockOnly: true,
    sort: 'featured',
    page: 1,
    limit: TRENDING_PER_SHOP_RESULT_CAP,
    language: options?.language,
  }))
  const merged = interleaveShopResults(groups, limit)

  return {
    items: merged.map(({ shop, item }) => mapCatalogItemForSearchResult(shop, item)),
    meta: {
      shopsQueried: candidateShops.length,
      shopsSucceeded: groups.length,
      strategy: 'featured-fanout-v1-not-real-trending',
    },
  }
}

async function getPublicShop(
  shopIdOrSlug: string,
  customerCoordinates?: CustomerCoordinates | null,
) {
  const shop = await getMappedPublicShop(shopIdOrSlug)
  const item = await attachLiveEta(
    shop,
    mapPublicShopDetail(shop),
    customerCoordinates,
    'full',
  )

  return { item }
}

async function listPublicShopCatalog(
  shopIdOrSlug: string,
  query: ShopCatalogQueryInput,
  customerCoordinates?: CustomerCoordinates | null,
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
  const item = await attachLiveEta(
    shop,
    mapPublicShopDetail(shop),
    customerCoordinates,
    'full',
  )

  return {
    item,
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
  customerCoordinates?: CustomerCoordinates | null,
) {
  const shop = await getMappedPublicShop(shopIdOrSlug)
  const product = await getInventoryCatalogProduct({
    organizationId: shop.inventoryOrganizationId!,
    branchId: shop.inventoryBranchId!,
    productId,
    language,
  })
  const shopDetail = await attachLiveEta(
    shop,
    mapPublicShopDetail(shop),
    customerCoordinates,
    'full',
  )

  return {
    shop: shopDetail,
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
  listPublicShopCategories,
  listPublicShops,
  listTrendingProducts,
  searchPublicCatalog,
  validatePublicCart,
}
