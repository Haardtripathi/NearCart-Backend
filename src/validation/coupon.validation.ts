import { z } from 'zod'

const validateCouponSchema = z.object({
  code: z.string().trim().min(1, 'Coupon code is required'),
  // Client-reported subtotal — used only for the advisory preview response. The authoritative
  // discount is recomputed server-side inside orders.service.ts's createOrder(), against the
  // real checkout snapshot subtotal, never this value. See coupon.service.ts's evaluateCoupon.
  subtotal: z.number().nonnegative(),
})

type ValidateCouponInput = z.infer<typeof validateCouponSchema>

export { validateCouponSchema }
export type { ValidateCouponInput }
