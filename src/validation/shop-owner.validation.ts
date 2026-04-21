import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

const optionalCoordinate = z.number().finite().optional().nullable()

const updateShopOwnerProfileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Full name must be at least 2 characters')
      .optional(),
    phone: optionalTrimmedString,
    businessName: z
      .string()
      .trim()
      .min(2, 'Business name must be at least 2 characters')
      .optional(),
    gstNumber: optionalTrimmedString,
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'At least one profile field is required',
  )

const createShopSchema = z.object({
  name: z.string().trim().min(2, 'Shop name must be at least 2 characters'),
  description: optionalTrimmedString,
  logoImageUrl: z.string().trim().url().optional().or(z.literal('')),
  category: z.string().trim().min(2, 'Category is required'),
  phone: z.string().trim().min(6, 'Phone number is required'),
  email: optionalTrimmedString,
  addressLine1: z.string().trim().min(1, 'Address line 1 is required'),
  addressLine2: optionalTrimmedString,
  city: z.string().trim().min(1, 'City is required'),
  area: optionalTrimmedString,
  pincode: z.string().trim().min(1, 'Pincode is required'),
  latitude: optionalCoordinate,
  longitude: optionalCoordinate,
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

type UpdateShopOwnerProfileInput = z.infer<typeof updateShopOwnerProfileSchema>
type CreateShopInput = z.infer<typeof createShopSchema>
type UpdateShopInput = z.infer<typeof updateShopSchema>

export {
  createShopSchema,
  updateShopOwnerProfileSchema,
  updateShopSchema,
}

export type {
  CreateShopInput,
  UpdateShopInput,
  UpdateShopOwnerProfileInput,
}
