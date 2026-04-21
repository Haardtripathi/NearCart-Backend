import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

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

export {
  cartValidationItemSchema,
  publicCartValidationSchema,
  shopCatalogQuerySchema,
}

export type {
  CartValidationItemInput,
  PublicCartValidationInput,
  ShopCatalogQueryInput,
}
