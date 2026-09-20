import { z } from 'zod'
import { cartValidationItemSchema } from './public.validation'

// Adversarial sweep bug fix: none of the free-text fields below had an upper bound — same
// live-confirmed unbounded-length gap as customer.validation.ts/shop-owner.validation.ts/
// auth.validation.ts, closed the same way here. `notes` in particular is customer-supplied
// free text stored verbatim per order with no bound at all previously.
const MAX_SHORT_TEXT_LENGTH = 200
const MAX_NOTES_LENGTH = 1000
const MAX_COUPON_CODE_LENGTH = 40
const MAX_ID_LENGTH = 100
const MAX_CHECKOUT_ITEMS = 200

const checkoutPayloadSchema = z.object({
  shopId: z.string().trim().min(1, 'Shop identifier is required').max(MAX_ID_LENGTH),
  addressId: z.string().trim().max(MAX_ID_LENGTH).optional().or(z.literal('')),
  customerName: z.string().trim().min(1, 'Customer name is required').max(MAX_SHORT_TEXT_LENGTH),
  customerPhone: z.string().trim().min(1, 'Phone is required').max(MAX_SHORT_TEXT_LENGTH),
  customerEmail: z
    .string()
    .trim()
    .email('Email must be valid')
    .optional()
    .or(z.literal('')),
  deliveryAddressLine1: z.string().trim().min(1, 'Address line 1 is required').max(MAX_SHORT_TEXT_LENGTH),
  deliveryAddressLine2: z.string().trim().max(MAX_SHORT_TEXT_LENGTH).optional().default(''),
  city: z.string().trim().min(1, 'City is required').max(MAX_SHORT_TEXT_LENGTH),
  area: z.string().trim().max(MAX_SHORT_TEXT_LENGTH).optional().default(''),
  pincode: z.string().trim().min(1, 'Pincode is required').max(MAX_SHORT_TEXT_LENGTH),
  landmark: z.string().trim().max(MAX_SHORT_TEXT_LENGTH).optional().default(''),
  // Only used when addressId is not provided (an ad-hoc, not-yet-saved
  // delivery address) — lets service-area gating still run for that case.
  // Ignored when a saved addressId is supplied (that address's own
  // latitude/longitude is used instead).
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).optional().default(''),
  paymentMethod: z.enum(['COD', 'ONLINE', 'PAY_ON_PICKUP']),
  // Round-2 promo/coupon feature — optional. Resolved and re-validated server-side against the
  // authoritative checkout subtotal inside orders.service.ts's createOrder(); never trusted for
  // the discount amount itself, only the code string.
  couponCode: z.string().trim().max(MAX_COUPON_CODE_LENGTH).optional().or(z.literal('')),
  // New feature: loyalty-points redemption at checkout. Optional — omitted/0 means "don't redeem
  // any" (the existing behavior, unaffected). The number here is only ever a *request*; the
  // authoritative amount actually redeemed is resolved server-side against the customer's real
  // balance inside orders.service.ts's createOrder() (see loyalty.service.ts's
  // `resolveLoyaltyRedemptionForCheckout`), the same "never trust a client-supplied money figure"
  // posture the coupon code already follows. Capped generously — the real cap is the customer's
  // balance and the per-order redemption ceiling, both enforced server-side.
  useLoyaltyPoints: z.number().int().min(0).max(1_000_000).optional(),
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
    .min(1, 'At least one cart item is required')
    .max(MAX_CHECKOUT_ITEMS, `An order can contain at most ${MAX_CHECKOUT_ITEMS} distinct items`),
})

type CheckoutPayloadInput = z.infer<typeof checkoutPayloadSchema>
type CheckoutItemInput = CheckoutPayloadInput['items'][number]

export { checkoutPayloadSchema }

export type { CheckoutItemInput, CheckoutPayloadInput }
