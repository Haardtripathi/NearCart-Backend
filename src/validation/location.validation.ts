import { z } from 'zod'

const autocompleteQuerySchema = z.object({
  input: z.string().trim().min(1, 'input is required'),
  sessionToken: z.string().trim().optional(),
  language: z.string().trim().optional(),
  region: z.string().trim().length(2).optional(),
  // Optional bias origin — the customer's current delivery location. Ranks nearby matches first
  // instead of letting Google pick a globally prominent place with the same name.
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusMeters: z.coerce.number().positive().max(50_000).optional(),
})

// Either free text OR an autocomplete `placeId`. The place id is the accurate path and is what
// the pickers send; plain `address` stays for manual/free-text lookups.
const geocodeQuerySchema = z
  .object({
    address: z.string().trim().min(1).optional(),
    placeId: z.string().trim().min(1).optional(),
  })
  .refine((value) => Boolean(value.address || value.placeId), {
    message: 'address or placeId is required',
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
