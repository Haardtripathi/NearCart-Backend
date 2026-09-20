import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

// Adversarial sweep bug fix: none of the free-text query/body fields below had an upper bound —
// same unbounded-length gap found and fixed across customer/shop-owner/auth/orders validation,
// closed here too. This endpoint set is entirely unauthenticated (public catalog browsing +
// cart validation), so it's the most exposed surface of the four to an oversized-payload probe —
// e.g. an arbitrarily long `q` search string, or a `productId`/`variantId` far longer than any
// real cuid, both previously accepted and forwarded as-is into the inventory-bridge fan-out.
const MAX_QUERY_TEXT_LENGTH = 100
const MAX_ID_LENGTH = 100
// A real customer cart realistically has a handful to a few dozen distinct line items — this is
// a generous ceiling, not a realistic-usage limit. Bounds the unauthenticated cart-validate
// endpoint's `items` array (previously `.min(1)` with no upper bound at all), so a single request
// can't force an arbitrarily large availability-check fan-out to the inventory bridge.
const MAX_CART_ITEMS = 200

const boundedOptionalTrimmedString = z
  .string()
  .trim()
  .max(MAX_QUERY_TEXT_LENGTH)
  .optional()
  .or(z.literal(''))

// Optional ad-hoc customer coordinates, used server-side (only) to compute
// the live delivery-ETA distance term — see `delivery-eta.service.ts` /
// `attachLiveEta` in `public-storefront.service.ts`. Anonymous browsing
// (no address chosen yet) omits these and the ETA falls back to a
// distance-free estimate rather than erroring.
const shopGeoQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
})

const shopListQuerySchema = shopGeoQuerySchema.extend({
  search: boundedOptionalTrimmedString,
  category: boundedOptionalTrimmedString,
  city: boundedOptionalTrimmedString,
})

const publicSearchQuerySchema = shopGeoQuerySchema.extend({
  q: z.string().trim().min(2, 'Search query must be at least 2 characters').max(MAX_QUERY_TEXT_LENGTH),
  category: boundedOptionalTrimmedString,
  city: boundedOptionalTrimmedString,
  limit: z.coerce.number().int().min(1).max(60).default(24),
  lang: boundedOptionalTrimmedString,
})

const publicTrendingQuerySchema = shopGeoQuerySchema.extend({
  category: boundedOptionalTrimmedString,
  city: boundedOptionalTrimmedString,
  limit: z.coerce.number().int().min(1).max(40).default(20),
  lang: boundedOptionalTrimmedString,
})

const shopCatalogQuerySchema = z.object({
  search: boundedOptionalTrimmedString,
  category: boundedOptionalTrimmedString,
  brand: boundedOptionalTrimmedString,
  inStockOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z
    .enum(['featured', 'name-asc', 'price-asc', 'price-desc', 'newest'])
    .default('featured'),
  lang: boundedOptionalTrimmedString,
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
})

const cartValidationItemSchema = z.object({
  productId: z.string().trim().min(1, 'Product identifier is required').max(MAX_ID_LENGTH),
  variantId: boundedOptionalTrimmedString,
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
  expectedPrice: z.number().min(0).optional(),
  expectedMrp: z.number().min(0).nullable().optional(),
})

const publicCartValidationSchema = z.object({
  shopId: z.string().trim().min(1, 'Shop identifier is required').max(MAX_ID_LENGTH),
  items: z
    .array(cartValidationItemSchema)
    .min(1, 'At least one cart item is required')
    .max(MAX_CART_ITEMS, `A cart can contain at most ${MAX_CART_ITEMS} distinct items`),
  lang: boundedOptionalTrimmedString,
  // Optional ad-hoc customer coordinates. Added so `/public/cart/validate` can enforce the same
  // service-radius check `POST /orders` already enforces at checkout (previously this endpoint
  // had no way to receive customer coordinates at all, so a cart 440km from the shop would
  // validate as fully purchasable and only get rejected at the final checkout call — see
  // `validatePublicCart` in `public-storefront.service.ts`). Deliberately optional, not
  // required: the frontend may call this endpoint before a delivery address is chosen (e.g.
  // while still browsing a cart), and making it required would break any existing caller that
  // doesn't send it yet. When omitted, the radius check is silently skipped here (same
  // fail-open-on-missing-data posture `assertWithinServiceArea` already uses for checkout) —
  // only the shop-open check (which needs no customer location) is unconditionally enforced.
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
})

type ShopCatalogQueryInput = z.infer<typeof shopCatalogQuerySchema>
type CartValidationItemInput = z.infer<typeof cartValidationItemSchema>
type PublicCartValidationInput = z.infer<typeof publicCartValidationSchema>
type ShopGeoQueryInput = z.infer<typeof shopGeoQuerySchema>
type ShopListQueryInput = z.infer<typeof shopListQuerySchema>
type PublicSearchQueryInput = z.infer<typeof publicSearchQuerySchema>
type PublicTrendingQueryInput = z.infer<typeof publicTrendingQuerySchema>

export {
  cartValidationItemSchema,
  publicCartValidationSchema,
  publicSearchQuerySchema,
  publicTrendingQuerySchema,
  shopCatalogQuerySchema,
  shopGeoQuerySchema,
  shopListQuerySchema,
}

export type {
  CartValidationItemInput,
  PublicCartValidationInput,
  PublicSearchQueryInput,
  PublicTrendingQueryInput,
  ShopCatalogQueryInput,
  ShopGeoQueryInput,
  ShopListQueryInput,
}
