import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

// Same shape as `optionalTrimmedString` but with an upper bound — a plain `.pipe()` onto that
// schema doesn't work here since piping runs unconditionally, including on the `undefined` case
// `.optional()` produces, and `z.string().max()` doesn't accept `undefined`; this builds the
// bounded string schema first instead.
function optionalTrimmedStringMax(max: number) {
  return z.string().trim().max(max).optional().or(z.literal(''))
}

// Adversarial sweep bug fix: was `z.number().finite().optional().nullable()` — accepted any
// finite number at all, including nonsense like latitude 999 or longitude -999 (confirmed live:
// a 201 with those values stored as-is). Every distance/ETA/delivery-fee calculation downstream
// (`haversineDistanceKm`, `assertWithinServiceArea`, `delivery-eta.service.ts`) assumes real
// coordinates and silently produces garbage (NaN or wildly wrong distances) for out-of-range
// input rather than erroring — worse than just an ugly value, since a bogus "within range"/"out
// of range" service-area decision can follow from it. `public.validation.ts`'s
// `shopGeoQuerySchema` and `orders.validation.ts`'s `checkoutPayloadSchema` already bound these
// correctly; this was the one place (shared with shop-owner.validation.ts's identical copy) that
// didn't.
const optionalLatitude = z.number().finite().min(-90).max(90).optional().nullable()
const optionalLongitude = z.number().finite().min(-180).max(180).optional().nullable()

// Adversarial sweep bug fix: none of these free-text fields had an upper bound — confirmed live,
// a 100,000-character `fullName` was accepted and stored as-is (200 OK). Bounds below are
// generous (real names/labels/addresses are always far shorter) — purpose is closing an
// unbounded-storage/rendering-abuse vector, not constraining legitimate input.
const MAX_NAME_LENGTH = 150
const MAX_LABEL_LENGTH = 60
const MAX_PHONE_LENGTH = 20
const MAX_ADDRESS_LINE_LENGTH = 200
const MAX_CITY_AREA_LENGTH = 100
const MAX_PINCODE_LENGTH = 20
const MAX_LANDMARK_LENGTH = 200

const optionalLine2 = optionalTrimmedStringMax(MAX_ADDRESS_LINE_LENGTH)
const optionalArea = optionalTrimmedStringMax(MAX_CITY_AREA_LENGTH)
const optionalLandmark = optionalTrimmedStringMax(MAX_LANDMARK_LENGTH)

const updateCustomerProfileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Full name must be at least 2 characters')
      .max(MAX_NAME_LENGTH, `Full name must be at most ${MAX_NAME_LENGTH} characters`)
      .optional(),
    phone: optionalTrimmedString,
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'At least one profile field is required',
  )

const createAddressSchema = z.object({
  label: z.string().trim().min(1, 'Address label is required').max(MAX_LABEL_LENGTH),
  fullName: z.string().trim().min(2, 'Full name is required').max(MAX_NAME_LENGTH),
  phone: z.string().trim().min(6, 'Phone number is required').max(MAX_PHONE_LENGTH),
  line1: z.string().trim().min(1, 'Address line 1 is required').max(MAX_ADDRESS_LINE_LENGTH),
  line2: optionalLine2,
  city: z.string().trim().min(1, 'City is required').max(MAX_CITY_AREA_LENGTH),
  area: optionalArea,
  pincode: z.string().trim().min(1, 'Pincode is required').max(MAX_PINCODE_LENGTH),
  landmark: optionalLandmark,
  latitude: optionalLatitude,
  longitude: optionalLongitude,
  isDefault: z.boolean().optional(),
})

const updateAddressSchema = createAddressSchema
  .partial()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'At least one address field is required',
  )

const registerDeviceTokenSchema = z.object({
  expoPushToken: z.string().trim().min(1, 'Expo push token is required'),
  platform: optionalTrimmedString,
})

type UpdateCustomerProfileInput = z.infer<typeof updateCustomerProfileSchema>
type CreateAddressInput = z.infer<typeof createAddressSchema>
type UpdateAddressInput = z.infer<typeof updateAddressSchema>
type RegisterDeviceTokenInput = z.infer<typeof registerDeviceTokenSchema>

export {
  createAddressSchema,
  registerDeviceTokenSchema,
  updateAddressSchema,
  updateCustomerProfileSchema,
}

export type {
  CreateAddressInput,
  RegisterDeviceTokenInput,
  UpdateAddressInput,
  UpdateCustomerProfileInput,
}
