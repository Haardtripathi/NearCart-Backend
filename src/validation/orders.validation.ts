import { z } from 'zod'
import { cartValidationItemSchema } from './public.validation'

const checkoutPayloadSchema = z.object({
  shopId: z.string().trim().min(1, 'Shop identifier is required'),
  addressId: z.string().trim().optional().or(z.literal('')),
  customerName: z.string().trim().min(1, 'Customer name is required'),
  customerPhone: z.string().trim().min(1, 'Phone is required'),
  customerEmail: z
    .string()
    .trim()
    .email('Email must be valid')
    .optional()
    .or(z.literal('')),
  deliveryAddressLine1: z.string().trim().min(1, 'Address line 1 is required'),
  deliveryAddressLine2: z.string().trim().optional().default(''),
  city: z.string().trim().min(1, 'City is required'),
  area: z.string().trim().optional().default(''),
  pincode: z.string().trim().min(1, 'Pincode is required'),
  landmark: z.string().trim().optional().default(''),
  // Only used when addressId is not provided (an ad-hoc, not-yet-saved
  // delivery address) — lets service-area gating still run for that case.
  // Ignored when a saved addressId is supplied (that address's own
  // latitude/longitude is used instead).
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  notes: z.string().trim().optional().default(''),
  paymentMethod: z.enum(['COD', 'ONLINE', 'PAY_ON_PICKUP']),
  // Round-2 promo/coupon feature — optional. Resolved and re-validated server-side against the
  // authoritative checkout subtotal inside orders.service.ts's createOrder(); never trusted for
  // the discount amount itself, only the code string.
  couponCode: z.string().trim().optional().or(z.literal('')),
  // `expectedPrice`/`expectedMrp` are optional and only used, when present, to detect a price
  // change between whenever the client last saw this item's price and the moment checkout is
  // actually submitted — see `getAuthoritativeCheckoutSnapshot`/`createOrderLocked` in
  // `orders.service.ts`. Bug found via live cross-repo testing 2026-08-09: this endpoint used to
  // only accept `productId`/`variantId`/`quantity`, so even a client that wanted to guard against
  // a mid-checkout price change (the way `POST /public/cart/validate` already supports via these
  // same two fields) structurally could not — the fields were stripped by this very `.pick()`
  // before ever reaching validation. Kept optional so older/non-browser callers that don't send
  // them are unaffected; only a caller that does provide `expectedPrice` gets the changed-price
  // check enforced.
  items: z
    .array(
      cartValidationItemSchema.pick({
        productId: true,
        variantId: true,
        quantity: true,
        expectedPrice: true,
        expectedMrp: true,
      }),
    )
    .min(1, 'At least one cart item is required'),
})

type CheckoutPayloadInput = z.infer<typeof checkoutPayloadSchema>
type CheckoutItemInput = CheckoutPayloadInput['items'][number]

export { checkoutPayloadSchema }

export type { CheckoutItemInput, CheckoutPayloadInput }
