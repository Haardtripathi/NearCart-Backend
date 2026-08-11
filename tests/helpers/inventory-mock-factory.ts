/**
 * Shared factory for the `vi.mock('.../inventory-client.service', ...)` call each spec file that
 * hits `POST /public/cart/validate` or `POST /orders` needs to make (both paths call
 * `checkInventoryAvailability` — see `buildValidatedCartSnapshot` in
 * public-storefront.service.ts). Centralized here so three near-identical ~30-line mock blocks
 * don't drift from each other.
 *
 * `vi.mock(...)` itself still has to be called directly inside each spec file (vitest's hoisting
 * transform only rewrites `vi.mock` calls that appear literally in the file being transformed —
 * calling it from inside an imported helper function would register the mock too late, after the
 * real module has already been imported elsewhere in the graph).
 *
 * Correction (found by actually running the suite): passing this factory directly as
 * `vi.mock(path, createInventoryClientMock)` throws `Cannot access '__vi_import_0__' before
 * initialization` — vitest's hoist transform lifts the `vi.mock(...)` call above every import
 * statement in the file, including this one, so the imported binding isn't initialized yet at
 * the point the (now-hoisted) call site evaluates its arguments. Each spec file must instead pass
 * an arrow function that *calls* this factory — `vi.mock(path, () => createInventoryClientMock())`
 * — so the reference to the imported binding is only dereferenced lazily, when vitest actually
 * invokes the factory during module resolution (by which point imports have settled), not when
 * the hoisted call's arguments are constructed.
 */
import { vi } from 'vitest'

import { buildMockAvailabilityResponse } from './inventory-mock-data'

function createInventoryClientMock() {
  return {
    checkInventoryAvailability: vi.fn(async (input: {
      organizationId: string
      branchId: string
      items: Array<{ productId: string; variantId?: string | null; quantity: number }>
    }) => buildMockAvailabilityResponse(input)),

    // Called (fire-and-forget from the caller's perspective — see syncOrderToInventoryBridge in
    // orders.service.ts, which swallows failures) after every successful checkout. Resolved with
    // a plausible payload so checkout tests don't have noisy "failed to push order" console.error
    // output; nothing under test asserts on its return value.
    pushSalesOrderToInventory: vi.fn(async () => ({
      salesOrderId: `mock-sales-order-${Math.random().toString(36).slice(2)}`,
      orderNumber: 'MOCK-SO-0001',
      status: 'PENDING',
    })),

    getInventorySalesOrderStatus: vi.fn(async () => ({
      salesOrderId: 'mock-sales-order',
      orderNumber: 'MOCK-SO-0001',
      status: 'PENDING',
    })),

    cancelSalesOrderInInventory: vi.fn(async () => ({
      salesOrderId: 'mock-sales-order',
      orderNumber: 'MOCK-SO-0001',
      status: 'CANCELLED',
      cancelledAt: new Date().toISOString(),
    })),

    getInventoryActiveOrderCount: vi.fn(async () => ({ activeOrderCount: 0 })),

    getInventoryBridgeMeta: vi.fn(() => ({
      ready: true,
      strategy: 'mock',
      baseUrl: null,
      lastSync: null,
    })),

    listInventoryMarketplaceOrganizations: vi.fn(async () => ({ items: [] })),

    listInventoryCatalog: vi.fn(async () => ({
      items: [],
      pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0 },
      filters: { categories: [], brands: [] },
      shopInventory: {
        organization: { id: 'mock-org', name: 'Mock Org', slug: 'mock-org', currencyCode: 'INR' },
        branch: { id: 'mock-branch', name: 'Mock Branch', code: null },
      },
    })),

    // Not exercised by this suite (no test hits a single-product detail endpoint) — throwing
    // makes that fact loud instead of silently returning a fake product if something changes.
    getInventoryCatalogProduct: vi.fn(async () => {
      throw new Error('getInventoryCatalogProduct is not used by this test suite')
    }),
  }
}

export { createInventoryClientMock }
