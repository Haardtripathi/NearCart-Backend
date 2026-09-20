import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .or(z.literal(''))

// Adversarial sweep bug fix: `fullName`/`businessName` below had no upper bound — confirmed live
// against customer.validation.ts's identical `updateCustomerProfileSchema.fullName` gap (a
// 100,000-character name was accepted and stored, 200 OK) before that one was fixed; this file's
// copies had the same gap at registration time, closed the same way.
const MAX_NAME_LENGTH = 150

const baseRegisterSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(MAX_NAME_LENGTH),
  email: z.string().trim().email('Email must be valid'),
  phone: optionalTrimmedString,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    // bcrypt silently truncates at 72 bytes — without this cap, two different passwords
    // sharing the same first-72-byte prefix hash identically and authenticate as the same
    // password, and a user typing a long passphrase gets no indication that the tail of it
    // is being ignored. Rejecting up front with a clear message is strictly safer than that
    // silent truncation.
    .max(72, 'Password must be at most 72 characters long'),
})

const registerCustomerSchema = baseRegisterSchema

const registerShopOwnerSchema = baseRegisterSchema.extend({
  businessName: z
    .string()
    .trim()
    .min(2, 'Business name must be at least 2 characters')
    .max(MAX_NAME_LENGTH),
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
