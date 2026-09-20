import { Prisma, type Shop } from '@prisma/client'

import prisma from '../lib/prisma'
import { getCachedJson, shopDirectoryCacheKey } from '../lib/cache'
import { getDeliveryEtaMinutes } from './delivery-eta.service'
import { getShopRatingSummary } from './order-review.service'
import {
  checkInventoryAvailability,
  getInventoryCatalogProduct,
  listInventoryCatalog,
  listInventoryMarketplaceOrganizations,
  type InventoryAvailabilityResponse,
  type InventoryCatalogItem,
  type InventoryCatalogResponse,
} from './inventory-client.service'
import { getWeatherFeeForCondition, getWeatherImpact } from './weather.service'
import { createHttpError } from '../utils/httpError'
import {
  assertWithinServiceArea,
  buildBoundingBox,
  computeDeliveryFee,
  haversineDistanceKm,
} from '../utils/geo'
import { resolveBasketDeliveryAllocation } from './delivery-pricing.service'
import type { BasketAllocation } from './delivery-pricing.service'
import { assertShopIsOpenToday, getShopTodayStatus } from '../utils/shop-availability'
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

// Platform default "nearby" radius (km), used when a shop hasn't configured its own
// `serviceRadiusKm`. Mirrors `DRIVER_MATCH_RADIUS_KM`'s default on the sibling
// NearCart-Inventory backend (same kind of nearest-match radius), for consistency of what
// counts as "nearby" across the product.
const DEFAULT_SHOP_MATCH_RADIUS_KM = 15

// v1 bounded-fan-out tuning — see searchPublicCatalog/listTrendingProducts. No cross-shop
// search index exists; this trades completeness for a hard ceiling on concurrent outbound
// calls to the NearCart-Inventory bridge per customer request.
const SEARCH_FANOUT_SHOP_CAP = 15
const SEARCH_PER_SHOP_RESULT_CAP = 8
const TRENDING_FANOUT_SHOP_CAP = 10
const TRENDING_PER_SHOP_RESULT_CAP = 6

// Exactly the columns the public shop summary/list response is built from — `Shop` has ~35
// columns and the list renders ~15 of them, and this query is the one that grows with the size
// of the whole marketplace. `mapPublicShopSummary`, `getShopTodayStatus`, `isShopOpenNow` and
// `attachLiveEta` between them define this set; the geo columns are read server-side for the
// distance filter and then dropped from the response (see `mapPublicShopSummary`).
const PUBLIC_SHOP_SUMMARY_SELECT = {
  id: true,
  name: true,
  slug: true,
  category: true,
  description: true,
  city: true,
  area: true,
  logoImageUrl: true,
  estimatedDeliveryMinutes: true,
  minimumOrderAmount: true,
  deliveryFeeDefault: true,
  deliveryEnabled: true,
  openingTime: true,
  closingTime: true,
  isOpenToday: true,
  todayStatusReason: true,
  todayStatusUpdatedAt: true,
  latitude: true,
  longitude: true,
  serviceRadiusKm: true,
  inventoryOrganizationId: true,
  inventoryBranchId: true,
} satisfies Prisma.ShopSelect

type PublicShopSummaryRow = Prisma.ShopGetPayload<{
  select: typeof PUBLIC_SHOP_SUMMARY_SELECT
}>

type GeoScopedShop = Pick<Shop, 'latitude' | 'longitude' | 'serviceRadiusKm'>

// The shop directory and the category counts derive entirely from `Shop` rows that change only
// when an owner edits their shop or flips today's open/closed switch — not from anything
// price- or stock-sensitive, which is always read live from the inventory bridge. 60s keeps a
// closed-today flip visibly prompt even on an instance that didn't handle the write (the one
// that did drops its cached entries immediately, see `bumpShopDirectoryGeneration`); the
// category grid changes only when shops are added/approved, so it can afford longer.
const SHOP_LIST_CACHE_TTL_SECONDS = 60
const SHOP_CATEGORY_CACHE_TTL_SECONDS = 300
const SHOP_MAX_RADIUS_CACHE_TTL_SECONDS = 300

// Shop lists are paginated from here on. The default is generous enough that no realistic
// "shops near me" render is truncated today, while capping what a single response can ever be
// asked to serialize once the marketplace has thousands of shops per city.
const SHOP_LIST_DEFAULT_LIMIT = 50
const SHOP_LIST_MAX_LIMIT = 100

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

function isShopOpenNow(shop: Pick<Shop, 'openingTime' | 'closingTime'>): boolean | null {
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

function mapPublicShopSummary(shop: PublicShopSummaryRow) {
  const todayStatus = getShopTodayStatus(shop)
  // `isShopOpenNow` is a static opening/closing-time window check (Asia/Kolkata); `todayStatus`
  // is the shop owner's explicit daily confirmation. They're computed from different data and
  // used to independently disagree (e.g. `isOpenNow: true` alongside `todayStatus: "CLOSED"`
  // when the owner marks the shop closed today despite it being within normal hours) — a
  // response that's self-contradictory to any consumer reading only `isOpenNow`, the
  // more-naturally-named-but-less-authoritative of the two fields. `todayStatus` is the field
  // checkout actually enforces (`assertShopIsOpenToday`), so it wins: `isOpenNow` can never be
  // `true` when `todayStatus` is `CLOSED`. When the owner hasn't confirmed today at all
  // (`PENDING_CONFIRMATION`) or has confirmed `OPEN`, `isOpenNow` still reflects the raw
  // opening/closing-time window (unchanged from before) — the reconciliation only forces the
  // one direction that was actively misleading.
  const isOpenNow = todayStatus === 'CLOSED' ? false : isShopOpenNow(shop)

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
    isOpenNow,
    todayStatus,
    todayStatusReason: shop.todayStatusReason,
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
  shop: Pick<
    Shop,
    | 'latitude'
    | 'longitude'
    | 'estimatedDeliveryMinutes'
    | 'inventoryOrganizationId'
    | 'inventoryBranchId'
  >,
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

/**
 * Attaches the average-rating + review-count pair to a mapped public shop
 * DETAIL object (`OrderReview` aggregate grouped by `Shop.id`). Deliberately
 * only wired into the single-shop detail call sites below (`getPublicShop`,
 * `listPublicShopCatalog`, `getPublicCatalogProduct` — each resolves exactly
 * one shop), not `listPublicShops`'s N-shop summary list — an aggregate
 * query per shop in a list render is a cost worth avoiding the same way
 * `attachLiveEta`'s `'fast'` mode avoids per-shop external calls, and the
 * shop list card isn't where a rating needs to show today.
 */
async function attachRatingSummary<T extends Record<string, unknown>>(
  shop: Pick<Shop, 'id'>,
  mapped: T,
): Promise<T & { averageRating: number | null; reviewCount: number }> {
  const rating = await getShopRatingSummary(shop.id)

  return {
    ...mapped,
    averageRating: rating.averageRating,
    reviewCount: rating.reviewCount,
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
  // Distance-based delivery fee when we actually have both shop and customer coordinates to
  // measure between; same fail-open posture as `assertWithinServiceArea` (utils/geo.ts) for
  // missing coordinates — fall back to the shop's flat `deliveryFeeDefault` rather than blocking
  // or charging nothing, since there's nothing to compute a distance against.
  let deliveryFee = 0
  // Multi-shop basket (`basketShopIds`): this shop's share of ONE cluster-aware route fee rather
  // than a full independent fee, so a basket from two shops on the same street isn't charged two
  // complete deliveries. Re-derived server-side from the shop ids — the client's number is never
  // used — and null whenever clustering doesn't apply, in which case the single-shop behaviour
  // below is completely untouched. See `services/delivery-pricing.service.ts`.
  let basketAllocation: BasketAllocation | null = null

  if (shop.deliveryEnabled) {
    if (
      shop.latitude != null &&
      shop.longitude != null &&
      payload.latitude != null &&
      payload.longitude != null
    ) {
      basketAllocation = payload.basketShopIds?.length
        ? await resolveBasketDeliveryAllocation({
            shopId: shop.id,
            basketShopIds: payload.basketShopIds,
            latitude: payload.latitude,
            longitude: payload.longitude,
          })
        : null

      if (basketAllocation) {
        deliveryFee = basketAllocation.fee
      } else {
        const distanceKm = haversineDistanceKm(
          shop.latitude,
          shop.longitude,
          payload.latitude,
          payload.longitude,
        )
        deliveryFee = computeDeliveryFee(distanceKm)
      }
    } else {
      deliveryFee = shop.deliveryFeeDefault
    }
  }

  // Weather is only worth checking for a delivery that's actually happening (deliveryEnabled)
  // and only resolvable when the shop has real coordinates — otherwise there's nothing to charge
  // against, same fail-safe posture as `getWeatherImpact`'s own failure paths (0 surcharge,
  // condition 'unknown'). Called at most once per validate/checkout call here, and the resulting
  // `condition` (not a second call) is what `getWeatherFeeForCondition` derives the fee from.
  let weatherCondition = 'unknown'

  if (shop.deliveryEnabled && shop.latitude != null && shop.longitude != null) {
    const weatherImpact = await getWeatherImpact(shop.latitude, shop.longitude)
    weatherCondition = weatherImpact.condition
  }

  // One trip through the weather is one surcharge. When this shop's order shares a trip with
  // another shop's, exactly one of them carries it (a deterministic function of the basket, so
  // every shop's validate/checkout call independently agrees on which) — otherwise a clustered
  // basket would pay the bad-weather premium twice for a single ride.
  const weatherSurchargeFee =
    basketAllocation && basketAllocation.combined && !basketAllocation.bearsWeatherSurcharge
      ? 0
      : getWeatherFeeForCondition(weatherCondition)
  const totalAmount = subtotal + deliveryFee + weatherSurchargeFee

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
      // Present (non-null) only when this shop's delivery is genuinely sharing a trip with other
      // shops in the same basket, so a client can say "one trip covers both" instead of quietly
      // showing a smaller number than the shop's page advertised.
      deliveryCluster: basketAllocation?.combined
        ? {
            shopIds: basketAllocation.clusterShopIds,
            routeKm: Number(basketAllocation.routeKm.toFixed(2)),
            independentFee: basketAllocation.independentFee,
          }
        : null,
      weatherSurchargeFee,
      weatherCondition,
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

/**
 * Widest service radius any publicly listed shop has configured, used to size the SQL bounding
 * box below. One aggregate over `Shop`, cached — it changes only when a shop owner edits their
 * radius, and re-running it on every shop-list request would cost exactly the round trip the
 * bounding box is there to save.
 */
async function getWidestServiceRadiusKm(): Promise<number> {
  return getCachedJson(
    shopDirectoryCacheKey('public-shop-widest-radius', null),
    SHOP_MAX_RADIUS_CACHE_TTL_SECONDS,
    async () => {
      const aggregate = await prisma.shop.aggregate({
        where: PUBLIC_MAPPED_SHOP_WHERE,
        _max: { serviceRadiusKm: true },
      })

      return Math.max(DEFAULT_SHOP_MATCH_RADIUS_KM, aggregate._max.serviceRadiusKm ?? 0)
    },
  )
}

function buildBoundingBoxWhere(
  customerCoordinates: CustomerCoordinates,
  radiusKm: number,
): Prisma.ShopWhereInput {
  const box = buildBoundingBox(
    customerCoordinates.latitude,
    customerCoordinates.longitude,
    radiusKm,
  )

  return {
    // A range predicate on a nullable column already excludes nulls, which matches the exact
    // filter's "a shop with no coordinates can't have its distance computed" rule.
    latitude: { gte: box.minLatitude, lte: box.maxLatitude },
    ...(box.minLongitude != null && box.maxLongitude != null
      ? { longitude: { gte: box.minLongitude, lte: box.maxLongitude } }
      : { longitude: { not: null } }),
  }
}

/**
 * SQL pre-filter for "shops that could possibly serve this customer", so the database returns a
 * neighbourhood rather than the whole country for the exact haversine pass to whittle down. It
 * is a strict superset of what `filterShopsInServiceRange` keeps, so results are identical:
 *
 *  - a shop whose radius is the default or smaller can only qualify within the default-radius
 *    box, which is the tight, common case;
 *  - a shop that has explicitly configured a wider radius is additionally admitted from a box
 *    sized to the widest radius in use.
 *
 * Splitting it that way matters because one shop configuring a 500km radius would otherwise
 * force every customer's pre-filter out to 500km and make it useless.
 */
async function buildServiceRangePrefilter(
  customerCoordinates: CustomerCoordinates,
): Promise<Prisma.ShopWhereInput> {
  const widestRadiusKm = await getWidestServiceRadiusKm()
  const nearBox = buildBoundingBoxWhere(customerCoordinates, DEFAULT_SHOP_MATCH_RADIUS_KM)

  if (widestRadiusKm <= DEFAULT_SHOP_MATCH_RADIUS_KM) {
    return nearBox
  }

  return {
    OR: [
      nearBox,
      {
        AND: [
          { serviceRadiusKm: { gt: DEFAULT_SHOP_MATCH_RADIUS_KM } },
          buildBoundingBoxWhere(customerCoordinates, widestRadiusKm),
        ],
      },
    ],
  }
}

interface ShopListPagination {
  page?: number | null
  limit?: number | null
}

function resolveShopListPagination(pagination?: ShopListPagination | null): {
  page: number
  limit: number
} {
  const limit = Math.min(
    Math.max(pagination?.limit ?? SHOP_LIST_DEFAULT_LIMIT, 1),
    SHOP_LIST_MAX_LIMIT,
  )

  return { page: Math.max(pagination?.page ?? 1, 1), limit }
}

async function computePublicShops(
  customerCoordinates: CustomerCoordinates | null | undefined,
  filters: { search?: string | null; category?: string | null; city?: string | null } | undefined,
  pagination: { page: number; limit: number },
) {
  const where: Prisma.ShopWhereInput = {
    ...PUBLIC_MAPPED_SHOP_WHERE,
    ...(customerCoordinates ? await buildServiceRangePrefilter(customerCoordinates) : {}),
    // Plain `contains`, deliberately no `mode: 'insensitive'` — this schema's datasource is
    // sqlite (see prisma/schema.prisma), which throws a PrismaClientValidationError on that
    // filter (postgres/mysql-only). SQLite's LIKE is already ASCII-case-insensitive, which
    // covers the realistic case of English shop names without it.
    ...(filters?.search ? { name: { contains: filters.search } } : {}),
    ...(filters?.category ? { category: filters.category } : {}),
    // `contains`, not exact equality — `Shop.city` is free text (see public.validation.ts's
    // `city` param docs), and SQLite's LIKE (which `contains` compiles to) is ASCII
    // case-insensitive, same reasoning as the `name`/search filter above. Exact equality here
    // previously meant a customer typing "mumbai" against a DB value of "Mumbai" silently got
    // zero shops back instead of a case-normalized match.
    ...(filters?.city ? { city: { contains: filters.city } } : {}),
  }

  // Without coordinates there is nothing to scope the directory by, so this is the one path that
  // could otherwise read every shop in the marketplace — it paginates in SQL. The geo path is
  // bounded by the bounding box instead: it has to see every candidate before it can sort by
  // distance, so capping it in SQL would bias which shops count as "nearest".
  const [shops, unscopedTotal] = await Promise.all([
    prisma.shop.findMany({
      select: PUBLIC_SHOP_SUMMARY_SELECT,
      where,
      orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
      ...(customerCoordinates
        ? {}
        : { skip: (pagination.page - 1) * pagination.limit, take: pagination.limit }),
    }),
    customerCoordinates ? Promise.resolve(0) : prisma.shop.count({ where }),
  ])

  // Hyperlocal filtering: only applied when the customer's coordinates are known. Each shop
  // is only "near" if it's within its own `serviceRadiusKm` (shop-owner-configured), falling
  // back to `DEFAULT_SHOP_MATCH_RADIUS_KM` when unset. A shop with no coordinates of its own
  // can't have its distance computed at all, so it's excluded from the geo-filtered result
  // rather than guessed at — same fail-closed posture as `attachLiveEta`'s distance term,
  // which just skips the travel-time component instead of erroring. When no customer
  // coordinates are supplied, behavior is unchanged from before: no filter, no sort, no
  // `distanceKm` field.
  let scopedShops: Array<{ shop: PublicShopSummaryRow; distanceKm: number | null }>
  let matchedTotal: number

  if (customerCoordinates) {
    const ranked = shops
      .filter((shop) => shop.latitude != null && shop.longitude != null)
      .map((shop) => ({
        shop,
        distanceKm: haversineDistanceKm(
          customerCoordinates.latitude,
          customerCoordinates.longitude,
          shop.latitude as number,
          shop.longitude as number,
        ),
      }))
      .filter(
        ({ shop, distanceKm }) =>
          distanceKm <= (shop.serviceRadiusKm ?? DEFAULT_SHOP_MATCH_RADIUS_KM),
      )
      .sort((a, b) => a.distanceKm - b.distanceKm)

    matchedTotal = ranked.length
    scopedShops = ranked.slice(
      (pagination.page - 1) * pagination.limit,
      pagination.page * pagination.limit,
    )
  } else {
    scopedShops = shops.map((shop) => ({ shop, distanceKm: null }))
    matchedTotal = unscopedTotal
  }

  const items = await Promise.all(
    scopedShops.map(async ({ shop, distanceKm }) => {
      const mapped = await attachLiveEta(
        shop,
        mapPublicShopSummary(shop),
        customerCoordinates,
        'fast',
      )

      return distanceKm != null
        ? { ...mapped, distanceKm: Number(distanceKm.toFixed(1)) }
        : mapped
    }),
  )

  return {
    items,
    meta: {
      // Unchanged meaning for existing callers: how many shops this response carries. `matched`
      // is the new field that knows about the ones beyond this page.
      total: items.length,
      matched: matchedTotal,
      page: pagination.page,
      limit: pagination.limit,
      hasMore: pagination.page * pagination.limit < matchedTotal,
    },
  }
}

/**
 * Cached for `SHOP_LIST_CACHE_TTL_SECONDS`. Coordinates are rounded into the cache key so
 * customers in the same ~110m block share an entry (the same trick the trending cache uses);
 * distances are still computed from the caller's exact coordinates on a miss. Nothing
 * stock- or price-sensitive is cached here — the shop directory is `Shop` rows only.
 */
async function listPublicShops(
  customerCoordinates?: CustomerCoordinates | null,
  filters?: { search?: string | null; category?: string | null; city?: string | null },
  pagination?: ShopListPagination | null,
) {
  const resolvedPagination = resolveShopListPagination(pagination)
  const cacheKey = shopDirectoryCacheKey('public-shops', [
    customerCoordinates
      ? [customerCoordinates.latitude.toFixed(3), customerCoordinates.longitude.toFixed(3)]
      : null,
    filters?.search ?? null,
    filters?.category ?? null,
    filters?.city ?? null,
    resolvedPagination.page,
    resolvedPagination.limit,
  ])

  return getCachedJson(cacheKey, SHOP_LIST_CACHE_TTL_SECONDS, () =>
    computePublicShops(customerCoordinates, filters, resolvedPagination),
  )
}

// Cheap local aggregation over the flat Shop.category string (shop-type: "Grocery",
// "Pharmacy", ...) — deliberately NOT the deeper per-shop product-category system from the
// inventory bridge (that stays scoped to listPublicShopCatalog's `filters.categories`, unchanged).
// Powers a home-page "browse by shop type" strip, Swiggy/Blinkit-style.
async function computePublicShopCategories(
  customerCoordinates: CustomerCoordinates | null | undefined,
) {
  // Coordinates known: only count shops that can actually deliver there, so the home category
  // grid never leads to an empty "No shops found" screen (same rule as listPublicShops).
  if (customerCoordinates) {
    const shops = await prisma.shop.findMany({
      // Counting categories needs four columns, not whole shop rows.
      select: { category: true, latitude: true, longitude: true, serviceRadiusKm: true },
      where: {
        ...PUBLIC_MAPPED_SHOP_WHERE,
        ...(await buildServiceRangePrefilter(customerCoordinates)),
      },
    })
    const counts = new Map<string, number>()
    for (const shop of filterShopsInServiceRange(shops, customerCoordinates)) {
      counts.set(shop.category, (counts.get(shop.category) ?? 0) + 1)
    }

    return {
      items: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, shopCount]) => ({ category, shopCount })),
    }
  }

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

async function listPublicShopCategories(customerCoordinates?: CustomerCoordinates | null) {
  const cacheKey = shopDirectoryCacheKey('public-shop-categories', [
    customerCoordinates
      ? [customerCoordinates.latitude.toFixed(3), customerCoordinates.longitude.toFixed(3)]
      : null,
  ])

  return getCachedJson(cacheKey, SHOP_CATEGORY_CACHE_TTL_SECONDS, () =>
    computePublicShopCategories(customerCoordinates),
  )
}

// Same hyperlocal rule as listPublicShops: a shop is "near" only if the customer is inside the
// shop's own `serviceRadiusKm` (falling back to DEFAULT_SHOP_MATCH_RADIUS_KM), and a shop with no
// coordinates of its own is excluded rather than guessed at. Nearest first.
function filterShopsInServiceRange<T extends GeoScopedShop>(
  shops: T[],
  customerCoordinates: CustomerCoordinates,
): T[] {
  return shops
    .filter((shop) => shop.latitude != null && shop.longitude != null)
    .map((shop) => ({
      shop,
      distanceKm: haversineDistanceKm(
        customerCoordinates.latitude,
        customerCoordinates.longitude,
        shop.latitude as number,
        shop.longitude as number,
      ),
    }))
    .filter(({ shop, distanceKm }) => distanceKm <= (shop.serviceRadiusKm ?? DEFAULT_SHOP_MATCH_RADIUS_KM))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map(({ shop }) => shop)
}

async function fetchCandidateShops(
  filters: { category?: string | null; city?: string | null } | undefined,
  take: number,
  customerCoordinates?: CustomerCoordinates | null,
): Promise<Shop[]> {
  const shops = await prisma.shop.findMany({
    where: {
      ...PUBLIC_MAPPED_SHOP_WHERE,
      ...(filters?.category ? { category: filters.category } : {}),
      // See listPublicShops above — `contains` for the same case-insensitivity reason, so
      // search/trending fan-out don't silently return zero candidate shops on a casing mismatch.
      ...(filters?.city ? { city: { contains: filters.city } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
    // With coordinates the fan-out cap has to apply AFTER the distance filter — capping first
    // would let far-away shops crowd the nearby ones out of the candidate set entirely.
    ...(customerCoordinates ? {} : { take }),
  })

  // BUG FIX (found on-device 2026-09-19): trending/search ignored the customer's location, so
  // the home screen advertised products from shops that weren't in "Shops near you" and
  // couldn't deliver to them. No coordinates supplied = unchanged legacy behavior.
  return customerCoordinates ? filterShopsInServiceRange(shops, customerCoordinates).slice(0, take) : shops
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
//
// Dedupes on `${item.id}:${item.primaryVariantId}` as it merges. Under normal data this is a
// no-op — inventory product/variant ids are globally unique cuids, so two genuinely different
// shops never produce a collision. But nothing in the schema stops two `Shop` rows from being
// mapped to the same `inventoryOrganizationId`/`inventoryBranchId` (confirmed live in prod:
// leftover test fixtures "Sweep Test Shop" and "E2E Test Shop 1786026141921" both point at the
// same branch) — when that happens, the fan-out queries the same underlying catalog twice and
// this function used to happily merge in the same product/variant under two different `shop`
// wrappers. That surfaced as a 100%-reproducible React "two children with the same key" console
// warning on the home page's TrendingRail (`${product.id}:${product.variantId}` as the list
// key) and duplicate-looking cards in trending/search results. Deduping here fixes it for both
// callers regardless of the underlying shop-mapping data issue.
function interleaveShopResults(
  groups: FannedOutShopCatalog[],
  limit: number,
): Array<{ shop: Shop; item: InventoryCatalogItem }> {
  const merged: Array<{ shop: Shop; item: InventoryCatalogItem }> = []
  const seenKeys = new Set<string>()
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
        addedInLastPass = true

        const key = `${item.id}:${item.primaryVariantId}`

        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          merged.push({ shop: group.shop, item })
        }
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
  options?: {
    category?: string | null
    city?: string | null
    limit?: number
    language?: string | null
    customerCoordinates?: CustomerCoordinates | null
  },
) {
  const limit = options?.limit ?? 24
  const candidateShops = await fetchCandidateShops(
    { category: options?.category, city: options?.city },
    SEARCH_FANOUT_SHOP_CAP,
    options?.customerCoordinates,
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
async function computeTrendingProducts(options?: {
  category?: string | null
  city?: string | null
  limit?: number
  language?: string | null
  customerCoordinates?: CustomerCoordinates | null
}) {
  const limit = options?.limit ?? 20
  const candidateShops = await fetchCandidateShops(
    { category: options?.category, city: options?.city },
    TRENDING_FANOUT_SHOP_CAP,
    options?.customerCoordinates,
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

// Trending fans out to every candidate shop's catalog over the inventory bridge — measured at
// 3-8 s per call on-device 2026-09-20, on the home screen's critical path, and recomputed for
// every customer even though the answer barely changes minute to minute. A short in-process TTL
// cache keyed by the query (coordinates rounded to ~100 m so neighbours share an entry) makes
// repeat loads instant; live stock/price is still re-validated at cart/checkout time.
const TRENDING_CACHE_TTL_MS = 60_000
const TRENDING_CACHE_MAX_ENTRIES = 200
const trendingCache = new Map<
  string,
  { expiresAt: number; value: Awaited<ReturnType<typeof computeTrendingProducts>> }
>()

async function listTrendingProducts(options?: Parameters<typeof computeTrendingProducts>[0]) {
  const coords = options?.customerCoordinates
  const cacheKey = JSON.stringify([
    options?.category ?? null,
    options?.city ?? null,
    options?.limit ?? null,
    options?.language ?? null,
    coords ? [coords.latitude.toFixed(3), coords.longitude.toFixed(3)] : null,
  ])
  const cached = trendingCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const value = await computeTrendingProducts(options)

  if (trendingCache.size >= TRENDING_CACHE_MAX_ENTRIES) {
    trendingCache.clear()
  }
  trendingCache.set(cacheKey, { expiresAt: Date.now() + TRENDING_CACHE_TTL_MS, value })

  return value
}

async function getPublicShop(
  shopIdOrSlug: string,
  customerCoordinates?: CustomerCoordinates | null,
) {
  const shop = await getMappedPublicShop(shopIdOrSlug)
  const item = await attachRatingSummary(
    shop,
    await attachLiveEta(shop, mapPublicShopDetail(shop), customerCoordinates, 'full'),
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
  const item = await attachRatingSummary(
    shop,
    await attachLiveEta(shop, mapPublicShopDetail(shop), customerCoordinates, 'full'),
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
  const shopDetail = await attachRatingSummary(
    shop,
    await attachLiveEta(shop, mapPublicShopDetail(shop), customerCoordinates, 'full'),
  )

  return {
    shop: shopDetail,
    item: mapCatalogItemForPublicApi(product.item),
    inventory: product.shopInventory,
  }
}

// Fix for the cart/validate-vs-checkout mismatch: `POST /orders` (checkout, in
// `orders.service.ts::createOrder`) enforces both `assertShopIsOpenToday` and
// `assertWithinServiceArea` before creating an order, but this endpoint previously enforced
// neither — a customer could review a fully priced, seemingly-valid cart for a shop that was
// closed, or 440km away, and only discover that at the final checkout call. Both asserts are
// deliberately run here, in `validatePublicCart`, rather than inside the shared
// `buildValidatedCartSnapshot` — that function also backs `getAuthoritativeCheckoutSnapshot`
// (the checkout path), which already runs its own equivalent checks in `createOrder` using
// address-resolution logic (saved address lookup, ad-hoc payload fallback) that lives in
// `orders.service.ts` and isn't available at this layer. Keeping the checks here, scoped to
// only this endpoint, fixes the validate-time gap without touching checkout's existing
// (already-correct, per E2E scenario B3/B4) behavior or error precedence.
//
// `assertShopIsOpenToday` is unconditional — it needs no customer location, so there's no
// reason to ever skip it here. `assertWithinServiceArea` only runs the actual distance
// comparison when both `payload.latitude`/`payload.longitude` are present (it already no-ops
// internally on missing shop or customer coordinates) — so a frontend that hasn't started
// sending coordinates at validate-time yet still gets the shop-open check, just not the radius
// check, until it's updated to send them.
async function validatePublicCart(payload: PublicCartValidationInput) {
  const shop = await getMappedPublicShop(payload.shopId)

  assertShopIsOpenToday(shop)
  assertWithinServiceArea(shop, payload.latitude ?? null, payload.longitude ?? null)

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
    // See `orders.validation.ts`'s doc comment on the same two fields — optional, only used to
    // detect a price change between whenever the caller last saw this item's price and this
    // checkout call.
    expectedPrice?: number
    expectedMrp?: number | null
  }>
  lang?: string | null
  // Forwarded into `buildValidatedCartSnapshot` so the delivery-fee distance calculation there
  // has real coordinates to work with at checkout time, not just at cart-validate time — without
  // these, checkout would silently fall back to the flat `deliveryFeeDefault` even though
  // `buildValidatedCartSnapshot` supports distance-based pricing (see caller in
  // `orders.service.ts`'s `createOrderLocked`, which now resolves these before this call).
  latitude?: number | null
  longitude?: number | null
  // The other shops in the same multi-shop basket, if any — forwarded so checkout charges the
  // same cluster-aware share the cart preview quoted, instead of a full independent fee. The
  // server re-derives the clustering from these ids itself; see `resolveBasketDeliveryAllocation`.
  basketShopIds?: string[] | null
}) {
  const snapshot = await buildValidatedCartSnapshot({
    shopId: payload.shopId,
    lang: payload.lang ?? undefined,
    latitude: payload.latitude,
    longitude: payload.longitude,
    basketShopIds: payload.basketShopIds ?? undefined,
    items: payload.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId ?? undefined,
      quantity: item.quantity,
      expectedPrice: item.expectedPrice,
      expectedMrp: item.expectedMrp,
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

  // Bug found via live cross-repo testing 2026-08-09: a caller that supplies `expectedPrice`
  // (the real frontend now does, right before this call — see `CheckoutPage.tsx`'s submit-time
  // client-side check) must not have that signal silently dropped here. Without this, a shop
  // could change a price between whenever the customer last saw it and the moment checkout
  // actually runs, and the order would be created at the new price with no indication anywhere
  // in the response — confirmed live (a 100% price increase went through as a normal 201).
  // Deliberately keyed off "was `expectedPrice` provided at all" (each `changedPriceItems` entry
  // only exists when the caller sent `expectedPrice` for that item — see
  // `buildValidatedCartSnapshot`'s `priceChanged` check) rather than always blocking on any
  // computed price difference — an older/non-browser caller that never sends `expectedPrice`
  // keeps today's existing behavior (checkout proceeds at the live price) rather than being
  // newly broken by a check it has no way to satisfy.
  if (snapshot.changedPriceItems.length > 0) {
    throw createHttpError(
      400,
      'Prices changed for one or more items in your cart. Please review the updated prices and try again.',
      {
        code: 'CART_PRICE_CHANGED',
        validation: {
          invalidItems: snapshot.invalidItems,
          outOfStockItems: snapshot.outOfStockItems,
          changedPriceItems: snapshot.changedPriceItems,
          appliedItems: snapshot.appliedItems,
          summary: snapshot.summary,
        },
      },
    )
  }

  return snapshot
}

async function listInventoryMappingOptions(search?: string | null) {
  return listInventoryMarketplaceOrganizations(search)
}

export {
  PUBLIC_SHOP_WHERE,
  attachLiveEta,
  getAuthoritativeCheckoutSnapshot,
  getMappedPublicShop,
  getPublicCatalogProduct,
  getPublicShop,
  listInventoryMappingOptions,
  listPublicShopCatalog,
  listPublicShopCategories,
  listPublicShops,
  listTrendingProducts,
  mapPublicShopSummary,
  searchPublicCatalog,
  validatePublicCart,
}
