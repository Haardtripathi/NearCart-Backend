import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

const baseRegisterSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters'),
  email: z.string().trim().email('Email must be valid'),
  phone: optionalTrimmedString,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long'),
})

const registerCustomerSchema = baseRegisterSchema

const registerShopOwnerSchema = baseRegisterSchema.extend({
  businessName: z
    .string()
    .trim()
    .min(2, 'Business name must be at least 2 characters'),
  gstNumber: optionalTrimmedString,
})

const loginSchema = z.object({
  email: z.string().trim().email('Email must be valid'),
  password: z.string().min(1, 'Password is required'),
})

type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>
type RegisterShopOwnerInput = z.infer<typeof registerShopOwnerSchema>
type LoginInput = z.infer<typeof loginSchema>

export {
  loginSchema,
  registerCustomerSchema,
  registerShopOwnerSchema,
}

export type {
  LoginInput,
  RegisterCustomerInput,
  RegisterShopOwnerInput,
}
