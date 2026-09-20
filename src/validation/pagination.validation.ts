import { z } from 'zod'

/**
 * Shared opt-in pagination for list endpoints that previously read a whole table.
 *
 * Both fields are optional so existing clients that send neither keep working — they get the
 * first page at the endpoint's own default size, and `meta.matched`/`meta.hasMore` tell them
 * there is more. The service layer, not this schema, owns the default and maximum page size,
 * since those differ per endpoint.
 */
const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

type PaginationQueryInput = z.infer<typeof paginationQuerySchema>

export { paginationQuerySchema }
export type { PaginationQueryInput }
