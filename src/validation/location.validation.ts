import { z } from 'zod'

const autocompleteQuerySchema = z.object({
  input: z.string().trim().min(1, 'input is required'),
  sessionToken: z.string().trim().optional(),
  language: z.string().trim().optional(),
  region: z.string().trim().length(2).optional(),
})

const geocodeQuerySchema = z.object({
  address: z.string().trim().min(1, 'address is required'),
})

const reverseGeocodeQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
})

type AutocompleteQueryInput = z.infer<typeof autocompleteQuerySchema>
type GeocodeQueryInput = z.infer<typeof geocodeQuerySchema>
type ReverseGeocodeQueryInput = z.infer<typeof reverseGeocodeQuerySchema>

export { autocompleteQuerySchema, geocodeQuerySchema, reverseGeocodeQuerySchema }
export type { AutocompleteQueryInput, GeocodeQueryInput, ReverseGeocodeQueryInput }
