import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
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
  search: optionalTrimmedString,
  category: optionalTrimmedString,
  city: optionalTrimmedString,
})

const publicSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Search query must be at least 2 characters'),
  category: optionalTrimmedString,
  city: optionalTrimmedString,
  limit: z.coerce.number().int().min(1).max(60).default(24),
  lang: optionalTrimmedString,
})

const publicTrendingQuerySchema = z.object({
  category: optionalTrimmedString,
  city: optionalTrimmedString,
  limit: z.coerce.number().int().min(1).max(40).default(20),
  lang: optionalTrimmedString,
})

const shopCatalogQuerySchema = z.object({
  search: optionalTrimmedString,
  category: optionalTrimmedString,
  brand: optionalTrimmedString,
  inStockOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z
    .enum(['featured', 'name-asc', 'price-asc', 'price-desc', 'newest'])
    .default('featured'),
  lang: optionalTrimmedString,
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
})

const cartValidationItemSchema = z.object({
  productId: z.string().trim().min(1, 'Product identifier is required'),
  variantId: optionalTrimmedString,
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
  expectedPrice: z.number().min(0).optional(),
  expectedMrp: z.number().min(0).nullable().optional(),
})

const publicCartValidationSchema = z.object({
  shopId: z.string().trim().min(1, 'Shop identifier is required'),
  items: z
    .array(cartValidationItemSchema)
    .min(1, 'At least one cart item is required'),
  lang: optionalTrimmedString,
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
