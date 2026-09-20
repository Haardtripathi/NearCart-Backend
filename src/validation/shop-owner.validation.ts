import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

// Same shape as `optionalTrimmedString` but with an upper bound — see customer.validation.ts's
// identical helper for why a plain `.pipe()` doesn't work here.
function optionalTrimmedStringMax(max: number) {
  return z.string().trim().max(max).optional().or(z.literal(''))
}

// Adversarial sweep bug fix: this used to be `z.number().finite().optional().nullable()` for both
// axes — accepted any finite number, including nonsense like latitude 999. See
// customer.validation.ts's identical fix (this file had its own copy of the same gap) for the
// full rationale.
const optionalLatitude = z.number().finite().min(-90).max(90).optional().nullable()
const optionalLongitude = z.number().finite().min(-180).max(180).optional().nullable()

// Adversarial sweep bug fix: none of these free-text fields had an upper bound (see
// customer.validation.ts's identical fix for the live-confirmed unbounded-length repro).
const MAX_NAME_LENGTH = 150
const MAX_SHOP_NAME_LENGTH = 150
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_CATEGORY_LENGTH = 100
const MAX_PHONE_LENGTH = 20
const MAX_ADDRESS_LINE_LENGTH = 200
const MAX_CITY_AREA_LENGTH = 100
const MAX_PINCODE_LENGTH = 20

const updateShopOwnerProfileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Full name must be at least 2 characters')
      .max(MAX_NAME_LENGTH)
      .optional(),
    phone: optionalTrimmedString,
    businessName: z
      .string()
      .trim()
      .min(2, 'Business name must be at least 2 characters')
      .max(MAX_NAME_LENGTH)
      .optional(),
    gstNumber: optionalTrimmedString,
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'At least one profile field is required',
  )

const createShopSchema = z.object({
  name: z.string().trim().min(2, 'Shop name must be at least 2 characters').max(MAX_SHOP_NAME_LENGTH),
  description: optionalTrimmedStringMax(MAX_DESCRIPTION_LENGTH),
  logoImageUrl: z.string().trim().url().optional().or(z.literal('')),
  category: z.string().trim().min(2, 'Category is required').max(MAX_CATEGORY_LENGTH),
  phone: z.string().trim().min(6, 'Phone number is required').max(MAX_PHONE_LENGTH),
  email: optionalTrimmedString,
  addressLine1: z.string().trim().min(1, 'Address line 1 is required').max(MAX_ADDRESS_LINE_LENGTH),
  addressLine2: optionalTrimmedStringMax(MAX_ADDRESS_LINE_LENGTH),
  city: z.string().trim().min(1, 'City is required').max(MAX_CITY_AREA_LENGTH),
  area: optionalTrimmedStringMax(MAX_CITY_AREA_LENGTH),
  pincode: z.string().trim().min(1, 'Pincode is required').max(MAX_PINCODE_LENGTH),
  latitude: optionalLatitude,
  longitude: optionalLongitude,
  openingTime: optionalTrimmedString,
  closingTime: optionalTrimmedString,
  deliveryEnabled: z.boolean().optional(),
  minimumOrderAmount: z.number().int().min(0).optional(),
  deliveryFeeDefault: z.number().int().min(0).optional(),
  estimatedDeliveryMinutes: z.number().int().min(0).optional().nullable(),
  serviceRadiusKm: z.number().finite().min(0).optional().nullable(),
})

const updateShopSchema = createShopSchema
  .extend({
    isActive: z.boolean().optional(),
  })
  .partial()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'At least one shop field is required',
  )

// `reason` only means anything when `isOpen === false` (see `shop-owner.service.ts`'s
// `updateShopTodayStatus`, which clears it whenever `isOpen === true`) — free text, shop owner's
// choice (e.g. "Holiday"), so no enum/min-length constraint beyond a sane upper bound.
const updateShopTodayStatusSchema = z.object({
  isOpen: z.boolean(),
  reason: z.string().trim().max(200).optional().or(z.literal('')),
})

type UpdateShopOwnerProfileInput = z.infer<typeof updateShopOwnerProfileSchema>
type CreateShopInput = z.infer<typeof createShopSchema>
type UpdateShopInput = z.infer<typeof updateShopSchema>
type UpdateShopTodayStatusInput = z.infer<typeof updateShopTodayStatusSchema>

export {
  createShopSchema,
  updateShopOwnerProfileSchema,
  updateShopSchema,
  updateShopTodayStatusSchema,
}

export type {
  CreateShopInput,
  UpdateShopInput,
  UpdateShopOwnerProfileInput,
  UpdateShopTodayStatusInput,
}
