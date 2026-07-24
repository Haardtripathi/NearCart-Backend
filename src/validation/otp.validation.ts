import { z } from 'zod'

const verifyOtpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Verification code must be a 6-digit number'),
})

type VerifyOtpInput = z.infer<typeof verifyOtpSchema>

export { verifyOtpSchema }
export type { VerifyOtpInput }
