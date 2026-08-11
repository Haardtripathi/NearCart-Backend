/**
 * Canned "all items valid, in stock, known price" responses shaped like
 * `InventoryAvailabilityResponse` (see `src/services/inventory-client.service.ts`) — used by each
 * spec file's own `vi.mock('.../inventory-client.service', ...)` factory (vi.mock must be called
 * directly inside the file that needs it, per vitest's hoisting rules; this module just supplies
 * the plain-data builder so that logic isn't duplicated three times).
 *
 * Every item is priced at a single fixed `TEST_UNIT_PRICE`/`TEST_UNIT_MRP` — good enough for the
 * fee-calculation tests in this suite, which only care that delivery-fee math is independent of
 * subtotal, plus one deterministic subtotal comparison in checkout-fee-parity.spec.ts.
 */

const TEST_UNIT_PRICE = 100
const TEST_UNIT_MRP = 120

interface MockAvailabilityItemInput {
  productId: string
  variantId?: string | null
  quantity: number
}

interface MockAvailabilityRequestInput {
  organizationId: string
  branchId: string
  items: MockAvailabilityItemInput[]
}

function buildMockAvailabilityResponse(input: MockAvailabilityRequestInput) {
  const items = input.items.map((item) => {
    const variantId = item.variantId ?? `${item.productId}-variant`

    return {
      productId: item.productId,
      variantId,
      requestedQuantity: item.quantity,
      quantityAccepted: item.quantity,
      availableQuantity: item.quantity + 100,
      price: TEST_UNIT_PRICE,
      mrp: TEST_UNIT_MRP,
      stockStatus: 'IN_STOCK' as const,
      status: 'VALID' as const,
      reason: null,
      product: {
        id: item.productId,
        slug: item.productId,
        name: `Test Product ${item.productId}`,
        description: null,
        imageUrl: null,
        price: TEST_UNIT_PRICE,
        mrp: TEST_UNIT_MRP,
        stockStatus: 'IN_STOCK' as const,
        availableQty: item.quantity + 100,
        isAvailable: true,
        category: null,
        brand: null,
        unitLabel: 'unit',
        hasVariants: false,
        variantCount: 1,
        primaryVariantId: variantId,
      },
    }
  })

  return {
    items,
    summary: {
      validCount: items.length,
      invalidCount: 0,
    },
    shopInventory: {
      organization: {
        id: input.organizationId,
        name: 'Test Organization',
        slug: 'test-organization',
        currencyCode: 'INR',
      },
      branch: {
        id: input.branchId,
        name: 'Test Branch',
        code: null,
      },
    },
  }
}

export { buildMockAvailabilityResponse, TEST_UNIT_MRP, TEST_UNIT_PRICE }
