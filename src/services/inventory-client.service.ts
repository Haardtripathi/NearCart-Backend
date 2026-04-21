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
  method?: 'GET' | 'POST'
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
      throw createHttpError(502, await readInventoryError(response))
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

export {
  checkInventoryAvailability,
  getInventoryBridgeMeta,
  getInventoryCatalogProduct,
  listInventoryCatalog,
  listInventoryMarketplaceOrganizations,
}

export type {
  InventoryAvailabilityResponse,
  InventoryCatalogFilters,
  InventoryCatalogItem,
  InventoryCatalogProductResponse,
  InventoryCatalogResponse,
  InventoryMarketplaceOption,
}
