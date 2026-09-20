import env from '../config/env'
import { createHttpError } from '../utils/httpError'

interface InventoryApiEnvelope<T> {
  success: boolean
  message: string
  data: T
}

type CatalogSort =
  | 'featured'
  | 'name-asc'
  | 'price-asc'
  | 'price-desc'
  | 'newest'

interface InventoryMarketplaceOption {
  id: string
  name: string
  slug: string
  currencyCode: string
  status: string
  branches: Array<{
    id: string
    code: string | null
    name: string
    type: string
    city: string | null
    isActive: boolean
  }>
}

interface InventoryCatalogFilters {
  categories: Array<{
    id: string
    slug: string
    name: string
    translations?: Record<string, { name: string | null; description: string | null }>
  }>
  brands: Array<{
    id: string
    slug: string
    name: string
    translations?: Record<string, { name: string | null; description: string | null }>
  }>
}

interface InventoryCatalogItem {
  id: string
  slug: string
  name: string
  description: string | null
  imageUrl: string | null
  price: number
  mrp: number | null
  stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK'
  availableQty: number
  isAvailable: boolean
  category: {
    id: string
    slug: string
    name: string
  } | null
  brand: {
    id: string
    slug: string
    name: string
  } | null
  unitLabel: string | null
  hasVariants: boolean
  variantCount: number
  primaryVariantId: string
  translations?: Record<string, { name: string | null; description: string | null }>
  variants?: Array<{
    id: string
    sku: string
    barcode: string | null
    name: string
    imageUrl: string | null
    price: number
    mrp: number | null
    unitLabel: string | null
    isDefault: boolean
    translations?: Record<string, { name: string | null; description: string | null }>
    stock: {
      availableQty: number
      stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK'
      isAvailable: boolean
    }
  }>
}

interface InventoryCatalogResponse {
  items: InventoryCatalogItem[]
  pagination: {
    page: number
    limit: number
    totalItems: number
    totalPages: number
  }
  filters: InventoryCatalogFilters
  shopInventory: {
    organization: {
      id: string
      name: string
      slug: string
      currencyCode: string
    }
    branch: {
      id: string
      name: string
      code: string | null
      city?: string | null
      type?: string
    }
  }
}

interface InventoryCatalogProductResponse {
  item: InventoryCatalogItem
  shopInventory: InventoryCatalogResponse['shopInventory']
}

interface InventoryAvailabilityResponse {
  items: Array<{
    productId: string
    variantId: string | null
    requestedQuantity: number
    quantityAccepted: number
    availableQuantity: number
    price: number | null
    mrp: number | null
    stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK'
    status: 'VALID' | 'NOT_FOUND' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK'
    reason: string | null
    product?: InventoryCatalogItem
  }>
  summary: {
    validCount: number
    invalidCount: number
  }
  shopInventory: InventoryCatalogResponse['shopInventory']
}

interface InventoryRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  headers?: Record<string, string>
}

function getInventoryBridgeMeta() {
  return {
    ready: Boolean(env.inventoryServiceUrl && env.inventoryInternalToken),
    strategy: 'main-backend-bff-to-inventory-marketplace-api',
    baseUrl: env.inventoryServiceUrl || null,
    lastSync: null,
  }
}

function assertInventoryConfigured() {
  if (!env.inventoryServiceUrl) {
    throw createHttpError(
      503,
      'Inventory service URL is not configured for the marketplace bridge.',
    )
  }

  if (!env.inventoryInternalToken) {
    throw createHttpError(
      503,
      'Inventory internal token is not configured for the marketplace bridge.',
    )
  }
}

function buildInventoryUrl(
  path: string,
  query: InventoryRequestOptions['query'],
): string {
  const url = new URL(path, env.inventoryServiceUrl)

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

async function readInventoryError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as Partial<InventoryApiEnvelope<unknown>>
    return payload.message || `Inventory service request failed with ${response.status}.`
  } catch {
    return `Inventory service request failed with ${response.status}.`
  }
}

async function inventoryRequest<T>(
  path: string,
  options: InventoryRequestOptions = {},
): Promise<T> {
  assertInventoryConfigured()

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    env.inventoryRequestTimeoutMs,
  )

  try {
    const response = await fetch(buildInventoryUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-internal-service-token': env.inventoryInternalToken,
        ...(options.headers ?? {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const message = await readInventoryError(response)

      // Bug found via live cross-repo testing 2026-08-09: when a shop's mapped
      // NearCart-Inventory organization/branch is not `ACTIVE` (e.g. suspended — see
      // `marketplace.service.ts`'s `getMarketplaceOrganization`/`getMarketplaceBranch`, which every
      // catalog/availability-check call goes through), the bridge 404s with
      // "Active organization not found" / "Active branch not found for this organization". Left
      // unhandled, that internal-implementation-detail string was passed straight through to
      // customer-facing responses (`GET /public/shops/:slug/catalog`, `POST
      // /public/cart/validate`, and checkout) as a plain 404 — confusing wording (a customer has no
      // concept of an "organization"), and a 404 status code is also semantically wrong here: the
      // shop itself still exists in NearCart's own DB and is still listed, it's the back-office
      // link that's temporarily down, which is a 503-shaped situation, not a "this thing doesn't
      // exist" one. Deliberately narrow to these two exact upstream messages — every other 4xx from
      // this bridge (most importantly "Active product not found", the genuinely-a-404 case for a
      // single discontinued/missing item within an otherwise fine shop) must keep passing through
      // unchanged below.
      if (
        response.status === 404 &&
        (message === 'Active organization not found' ||
          message === 'Active branch not found for this organization')
      ) {
        throw createHttpError(
          503,
          'This shop is temporarily unavailable. Please check back later.',
          { code: 'SHOP_UNAVAILABLE' },
        )
      }

      // Pass through the upstream bridge's own 4xx (e.g. 404 for a product/org that doesn't
      // exist, 400 for a bad request) instead of flattening it to a generic 502 — found via
      // live testing 2026-07-29: `GET /public/shops/:slug/catalog/:productId` for a nonexistent
      // product returned 502 "bridge unavailable" instead of 404, which is both misleading (the
      // bridge is fine; the product just isn't there) and breaks callers that branch on status
      // code. Only a genuine 5xx/unexpected response from the bridge should still collapse to a
      // 502 here, since NearCart shouldn't forward Inventory's own internal error details to its
      // customers.
      if (response.status >= 400 && response.status < 500) {
        throw createHttpError(response.status, message)
      }

      throw createHttpError(502, message)
    }

    const payload = (await response.json()) as InventoryApiEnvelope<T>

    if (!payload.success) {
      throw createHttpError(
        502,
        payload.message || 'Inventory service returned an unsuccessful response.',
      )
    }

    return payload.data
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw createHttpError(
        504,
        'Inventory service request timed out while fetching marketplace data.',
      )
    }

    if ((error as { status?: number }).status) {
      throw error
    }

    throw createHttpError(
      502,
      'Inventory service is unavailable for marketplace requests right now.',
    )
  } finally {
    clearTimeout(timeout)
  }
}

function withLanguageHeaders(language?: string | null) {
  if (!language) {
    return undefined
  }

  return {
    'accept-language': language,
  }
}

async function listInventoryMarketplaceOrganizations(search?: string | null) {
  return inventoryRequest<{ items: InventoryMarketplaceOption[] }>(
    '/api/internal/marketplace/organizations',
    {
      query: {
        search: search ?? undefined,
      },
    },
  )
}

async function listInventoryCatalog(input: {
  organizationId: string
  branchId: string
  search?: string | null
  category?: string | null
  brand?: string | null
  inStockOnly?: boolean
  page?: number
  limit?: number
  sort?: CatalogSort
  language?: string | null
}) {
  return inventoryRequest<InventoryCatalogResponse>(
    `/api/internal/marketplace/organizations/${input.organizationId}/catalog`,
    {
      query: {
        branchId: input.branchId,
        search: input.search ?? undefined,
        category: input.category ?? undefined,
        brand: input.brand ?? undefined,
        inStockOnly: input.inStockOnly,
        page: input.page,
        limit: input.limit,
        sort: input.sort,
        lang: input.language ?? undefined,
      },
      headers: withLanguageHeaders(input.language),
    },
  )
}

async function getInventoryCatalogProduct(input: {
  organizationId: string
  branchId: string
  productId: string
  language?: string | null
}) {
  return inventoryRequest<InventoryCatalogProductResponse>(
    `/api/internal/marketplace/organizations/${input.organizationId}/catalog/${input.productId}`,
    {
      query: {
        branchId: input.branchId,
        lang: input.language ?? undefined,
      },
      headers: withLanguageHeaders(input.language),
    },
  )
}

async function checkInventoryAvailability(input: {
  organizationId: string
  branchId: string
  language?: string | null
  items: Array<{
    productId: string
    variantId?: string | null
    quantity: number
  }>
}) {
  return inventoryRequest<InventoryAvailabilityResponse>(
    `/api/internal/marketplace/organizations/${input.organizationId}/availability-check`,
    {
      method: 'POST',
      body: {
        branchId: input.branchId,
        items: input.items,
        lang: input.language ?? undefined,
      },
      headers: withLanguageHeaders(input.language),
    },
  )
}

interface PushSalesOrderInput {
  organizationId: string
  branchId: string
  externalOrderId: string
  externalOrderNumber?: string | null
  customer: {
    name: string
    phone: string
    addressLine?: string | null
    latitude?: number | null
    longitude?: number | null
  }
  items: Array<{
    inventoryProductId: string
    inventoryVariantId?: string | null
    quantity: number
    unitPrice: number
  }>
  notes?: string | null
  // Money facts for the shop + driver apps. The Inventory SalesOrder's own `total` only ever means
  // "goods value" (sum of `items`), so without this block the driver app told the driver to
  // collect the item total (e.g. 360) instead of what the customer actually owes (e.g. 434 incl.
  // delivery fee), and had no idea whether the order was prepaid. All amounts are whole rupees —
  // the same unit as `items[].unitPrice` and every `Int` money column on `Order`.
  payment?: PushSalesOrderPayment
}

interface PushSalesOrderPayment {
  method: 'COD' | 'ONLINE' | 'PAY_ON_PICKUP'
  status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED'
  itemTotal: number
  deliveryFee: number
  // Sent separately from `deliveryFee` (rather than folded into it) so the shop's bill summary
  // adds up line by line: itemTotal + deliveryFee + weatherSurchargeFee - discountTotal.
  weatherSurchargeFee?: number
  // Combined coupon + loyalty-points discount (`Order.discountAmount`).
  discountTotal: number
  // The loyalty-points portion of `discountTotal`, when any points were redeemed.
  loyaltyDiscount?: number
  couponCode?: string
  amountPayable: number
  currency: 'INR'
}

interface PushSalesOrderResponse {
  salesOrderId: string
  orderNumber: string
  status: string
}

interface InventorySalesOrderStatusResponse {
  salesOrderId: string
  orderNumber: string
  status: string
  rejectionReason?: string | null
  confirmedAt?: string | null
  deliveredAt?: string | null
  // Delivery-proof photo (Cloudinary URL). Optional: the sibling NearCart-Inventory repo may not
  // send this field on every deployment yet (it's being added there separately) — code reading
  // this response must treat a missing/undefined value the same as "no photo", not an error.
  deliveryProofPhotoUrl?: string | null
  // Assigned-driver identity/contact, mirroring the DRIVER_ASSIGNED/DRIVER_UNASSIGNED webhook
  // payload — added as a poll-path fallback for driver info, since that webhook is
  // fire-and-forget with no retry on the Inventory side (a dropped webhook used to mean the
  // customer never learned who was delivering their order, with no way to recover). `undefined`
  // means an older bridge deployment that doesn't select this relation yet (treat as "no signal,
  // leave existing driver fields alone"); `null` means the relation was selected and there is
  // genuinely no driver assigned right now (treat as "clear any stored driver info").
  assignedDriver?: { fullName: string; phone: string; vehicleType: string } | null
  driverAssignedAt?: string | null
  // The shop's partial-fulfilment proposal ("I can only supply 3 of your 5 items") and where it
  // stands. `undefined` means an Inventory deployment that predates the feature (no signal);
  // `null` means there is genuinely nothing for the customer to review. See
  // `InventoryPartialFulfilment` below.
  partialFulfilment?: InventoryPartialFulfilment | null
}

/**
 * Mirrors `utils/partialFulfilment.ts` in the NearCart-Inventory repo. Amounts are whole rupees,
 * the same unit as every `Int` money column on `Order`.
 *
 * `productId`/`variantId` on each entry are the INVENTORY catalog ids — they are what this app
 * matches its own `OrderItem` rows against (`inventoryProductId`/`inventoryVariantId`), since
 * `itemId` is a `SalesOrderItem.id` this app has no copy of.
 */
interface InventoryPartialFulfilmentRemovedItem {
  itemId: string
  productId: string | null
  variantId: string | null
  name: string
  variantName: string | null
  quantity: number
  lineTotal: number
  reason: string | null
}

interface InventoryPartialFulfilmentReducedItem {
  itemId: string
  productId: string | null
  variantId: string | null
  name: string
  variantName: string | null
  fromQuantity: number
  toQuantity: number
  lineTotal: number
}

interface InventoryPartialFulfilment {
  state: 'AWAITING_CUSTOMER' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED'
  proposedAt: string
  respondedAt: string | null
  expiresAt: string
  note: string | null
  removedItems: InventoryPartialFulfilmentRemovedItem[]
  reducedItems: InventoryPartialFulfilmentReducedItem[]
  originalTotal: number
  proposedTotal: number
  proposedAmountPayable: number | null
}

interface PartialFulfilmentResponseResult {
  salesOrderId: string
  orderNumber: string
  status: string
  partialFulfilment?: InventoryPartialFulfilment | null
  /** false when the proposal had already been answered — the call was a successful no-op. */
  applied: boolean
}

// NOTE ON PATH PREFIX: the bridge contract this was built against
// (see NearCart CLAUDE.md / PHASE1_REQUIREMENTS.md) specifies bare paths
// `/organizations/:organizationId/sales-orders` and
// `/sales-orders/by-external/:externalOrderId`. Every other marketplace
// bridge endpoint in NearCart-Inventory lives under the
// `/api/internal/marketplace` prefix behind `requireInternalServiceAuth`
// (see that repo's `routes/index.ts`), so these calls are namespaced the
// same way for consistency — adjust this prefix if the real implementation
// (being built in parallel) mounts them elsewhere.
const MARKETPLACE_BRIDGE_PREFIX = '/api/internal/marketplace'

/**
 * Pushes a NearCart `Order` into NearCart-Inventory as a `SalesOrder`
 * (source=APP). Intentionally does not throw on the caller's behalf in a
 * way that should abort order creation — callers should catch failures and
 * let the local order persist regardless (see `orders.service.ts`).
 */
async function pushSalesOrderToInventory(
  input: PushSalesOrderInput,
): Promise<PushSalesOrderResponse> {
  return inventoryRequest<PushSalesOrderResponse>(
    `${MARKETPLACE_BRIDGE_PREFIX}/organizations/${input.organizationId}/sales-orders`,
    {
      method: 'POST',
      body: {
        branchId: input.branchId,
        externalOrderId: input.externalOrderId,
        externalOrderNumber: input.externalOrderNumber ?? undefined,
        customer: input.customer,
        items: input.items,
        notes: input.notes ?? undefined,
        payment: input.payment ?? undefined,
      },
    },
  )
}

/**
 * Reads back the current status of a previously-pushed SalesOrder by this
 * app's own Order id, so `NearCart` can reflect shop-owner actions
 * (confirm/reject/ready/out-for-delivery/deliver) taken in the Inventory
 * dashboard.
 */
async function getInventorySalesOrderStatus(
  externalOrderId: string,
): Promise<InventorySalesOrderStatusResponse> {
  return inventoryRequest<InventorySalesOrderStatusResponse>(
    `${MARKETPLACE_BRIDGE_PREFIX}/sales-orders/by-external/${externalOrderId}`,
  )
}

/**
 * Sends the customer's answer to a shop's partial-fulfilment proposal back across the bridge.
 * Accepting there applies the reduced item set, confirms the order and moves stock for the final
 * quantities only; declining cancels it. Idempotent on the Inventory side — a repeat call
 * returns the current state with `applied: false` rather than erroring.
 *
 * `revisedPayment` is how this app corrects the bill when its OWN rules change it beyond the
 * plain item-total reduction Inventory can compute — above all a coupon whose minimum spend no
 * longer holds once items were dropped, which pushes the amount payable back UP. Without it the
 * shop and the driver would be told to collect the un-corrected figure.
 */
async function respondToInventoryPartialFulfilment(input: {
  organizationId: string
  externalOrderId: string
  accepted: boolean
  revisedPayment?: {
    discountTotal?: number
    loyaltyDiscount?: number
    couponCode?: string | null
    amountPayable?: number
  }
}): Promise<PartialFulfilmentResponseResult> {
  return inventoryRequest<PartialFulfilmentResponseResult>(
    `${MARKETPLACE_BRIDGE_PREFIX}/organizations/${input.organizationId}/sales-orders/by-external/${input.externalOrderId}/partial-response`,
    {
      method: 'POST',
      body: {
        accepted: input.accepted,
        ...(input.revisedPayment ? { revisedPayment: input.revisedPayment } : {}),
      },
    },
  )
}

interface CancelSalesOrderResponse {
  salesOrderId: string
  orderNumber: string
  status: string
  cancelledAt: string
}

/**
 * Cancels a previously-pushed SalesOrder on the Inventory side, keyed by
 * this app's own Order id (the same `externalOrderId` used when pushing).
 * Contract (locked against Track B, see NearCart CLAUDE.md /
 * PHASE1_REQUIREMENTS.md for the two-track precedent this mirrors):
 *
 *   PATCH /api/internal/marketplace/organizations/:organizationId/
 *     sales-orders/by-external/:externalOrderId/cancel
 *   200 -> { salesOrderId, orderNumber, status: "CANCELLED", cancelledAt }
 *   404 if externalOrderId not found; 409 if it can't be cancelled
 *   (already terminal on the Inventory side).
 *
 * Like `pushSalesOrderToInventory`, this intentionally does not throw on
 * the caller's behalf in a way that should abort the local cancel — see
 * `orders.service.ts`'s `cancelOrder`, which catches failures here and
 * still finalizes the local `CANCELLED` status, just flags the desync.
 */
async function cancelSalesOrderInInventory(input: {
  organizationId: string
  externalOrderId: string
}): Promise<CancelSalesOrderResponse> {
  return inventoryRequest<CancelSalesOrderResponse>(
    `${MARKETPLACE_BRIDGE_PREFIX}/organizations/${input.organizationId}/sales-orders/by-external/${input.externalOrderId}/cancel`,
    { method: 'PATCH' },
  )
}

interface ActiveOrderCountResponse {
  activeOrderCount: number
}

/**
 * Reads how many currently-active SalesOrders a branch has, used by
 * `delivery-eta.service.ts` as the "how busy is this shop right now" queue
 * signal. Contract (locked against Track B):
 *
 *   GET /api/internal/marketplace/organizations/:organizationId/
 *     branches/:branchId/active-order-count
 *   200 -> { activeOrderCount: number }
 */
async function getInventoryActiveOrderCount(input: {
  organizationId: string
  branchId: string
}): Promise<ActiveOrderCountResponse> {
  return inventoryRequest<ActiveOrderCountResponse>(
    `${MARKETPLACE_BRIDGE_PREFIX}/organizations/${input.organizationId}/branches/${input.branchId}/active-order-count`,
  )
}

export {
  cancelSalesOrderInInventory,
  checkInventoryAvailability,
  getInventoryActiveOrderCount,
  getInventoryBridgeMeta,
  getInventoryCatalogProduct,
  getInventorySalesOrderStatus,
  listInventoryCatalog,
  listInventoryMarketplaceOrganizations,
  pushSalesOrderToInventory,
  respondToInventoryPartialFulfilment,
}

export type {
  ActiveOrderCountResponse,
  CancelSalesOrderResponse,
  InventoryAvailabilityResponse,
  InventoryCatalogFilters,
  InventoryCatalogItem,
  InventoryCatalogProductResponse,
  InventoryCatalogResponse,
  InventoryMarketplaceOption,
  InventoryPartialFulfilment,
  InventoryPartialFulfilmentReducedItem,
  InventoryPartialFulfilmentRemovedItem,
  InventorySalesOrderStatusResponse,
  PartialFulfilmentResponseResult,
  PushSalesOrderInput,
  PushSalesOrderPayment,
  PushSalesOrderResponse,
}
