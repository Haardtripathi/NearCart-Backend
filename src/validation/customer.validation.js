const { z } = require('zod')

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

const optionalCoordinate = z.number().finite().optional().nullable()

const updateCustomerProfileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Full name must be at least 2 characters')
      .optional(),
    phone: optionalTrimmedString,
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'At least one profile field is required',
  )

const createAddressSchema = z.object({
  label: z.string().trim().min(1, 'Address label is required'),
  fullName: z.string().trim().min(2, 'Full name is required'),
  phone: z.string().trim().min(6, 'Phone number is required'),
  line1: z.string().trim().min(1, 'Address line 1 is required'),
  line2: optionalTrimmedString,
  city: z.string().trim().min(1, 'City is required'),
  area: optionalTrimmedString,
  pincode: z.string().trim().min(1, 'Pincode is required'),
  landmark: optionalTrimmedString,
  latitude: optionalCoordinate,
  longitude: optionalCoordinate,
  isDefault: z.boolean().optional(),
})

const updateAddressSchema = createAddressSchema
  .partial()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'At least one address field is required',
  )

module.exports = {
  createAddressSchema,
  updateAddressSchema,
  updateCustomerProfileSchema,
}
