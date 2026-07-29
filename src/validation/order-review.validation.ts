import { z } from 'zod'

const createOrderReviewSchema = z.object({
  rating: z.number().int().min(1, 'Rating must be at least 1').max(5, 'Rating cannot exceed 5'),
  comment: z.string().trim().max(2000, 'Comment is too long').optional().or(z.literal('')),
})

const shopReviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

type CreateOrderReviewInput = z.infer<typeof createOrderReviewSchema>
type ShopReviewsQueryInput = z.infer<typeof shopReviewsQuerySchema>

export { createOrderReviewSchema, shopReviewsQuerySchema }
export type { CreateOrderReviewInput, ShopReviewsQueryInput }
