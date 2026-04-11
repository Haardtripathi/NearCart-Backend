const { z } = require('zod')

const checkoutItemSchema = z.object({
  storeProductId: z.string().trim().min(1, 'Product identifier is required'),
  shopId: z.string().trim().min(1, 'Shop identifier is required'),
  shopName: z.string().trim().min(1, 'Shop name is required'),
  name: z.string().trim().min(1, 'Product name is required'),
  brand: z.string().trim().optional().default(''),
  size: z.string().trim().optional().default(''),
  image: z.string().trim().optional().default(''),
  price: z.number().int().min(0, 'Price must be 0 or more'),
  mrp: z.number().int().min(0, 'MRP must be 0 or more').optional(),
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
})

const checkoutPayloadSchema = z.object({
  shopId: z.string().trim().min(1, 'Shop identifier is required'),
  shopName: z.string().trim().min(1, 'Shop name is required'),
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
  notes: z.string().trim().optional().default(''),
  paymentMethod: z.enum(['COD', 'ONLINE', 'PAY_ON_PICKUP']),
  items: z
    .array(checkoutItemSchema)
    .min(1, 'At least one cart item is required'),
})

module.exports = {
  checkoutPayloadSchema,
}
