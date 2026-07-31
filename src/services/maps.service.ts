import env from '../config/env'
import { createHttpError } from '../utils/httpError'

const GOOGLE_MAPS_BASE_URL = 'https://maps.googleapis.com/maps/api'
const GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com/v1'

interface GoogleAddressComponent {
  long_name: string
  short_name: string
  types: string[]
}

interface GoogleGeometry {
  location: { lat: number; lng: number }
}

interface GoogleGeocodeResult {
  formatted_address: string
  place_id: string
  geometry: GoogleGeometry
  address_components: GoogleAddressComponent[]
}

interface GoogleGeocodeResponse {
  status: string
  error_message?: string
  results: GoogleGeocodeResult[]
}

interface GooglePlaceText {
  text?: string
}

interface GooglePlacePrediction {
  placeId?: string
  text?: GooglePlaceText
  structuredFormat?: {
    mainText?: GooglePlaceText
    secondaryText?: GooglePlaceText
  }
}

interface GooglePlacesAutocompleteResponse {
  suggestions?: {
    placePrediction?: GooglePlacePrediction
  }[]
}

function assertMapsConfigured(): void {
  if (!env.googleMapsApiKey) {
    throw createHttpError(
      503,
      'Google Maps is not configured on the server (GOOGLE_MAPS_API_KEY is unset).',
    )
  }
}

async function callGoogleMaps<T extends { status: string; error_message?: string }>(
  path: string,
  query: Record<string, string | undefined>,
): Promise<T> {
  assertMapsConfigured()

  const url = new URL(`${GOOGLE_MAPS_BASE_URL}${path}`)

  for (const [key, value] of Object.entries(query)) {
    if (value) {
      url.searchParams.set(key, value)
    }
  }

  url.searchParams.set('key', env.googleMapsApiKey)

  let response: Response

  try {
    response = await fetch(url.toString())
  } catch {
    throw createHttpError(502, 'Could not reach Google Maps right now.')
  }

  if (!response.ok) {
    throw createHttpError(502, `Google Maps request failed with ${response.status}.`)
  }

  const payload = (await response.json()) as T

  if (payload.status !== 'OK' && payload.status !== 'ZERO_RESULTS') {
    throw createHttpError(
      502,
      payload.error_message || `Google Maps returned status ${payload.status}.`,
    )
  }

  return payload
}

async function callGooglePlaces<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  assertMapsConfigured()

  let response: Response

  try {
    response = await fetch(`${GOOGLE_PLACES_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.googleMapsApiKey,
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw createHttpError(502, 'Could not reach Google Places right now.')
  }

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null

  if (!response.ok) {
    throw createHttpError(
      502,
      payload?.error?.message || `Google Places request failed with ${response.status}.`,
    )
  }

  return payload as T
}

function findComponent(
  components: GoogleAddressComponent[],
  type: string,
): string | null {
  return components.find((component) => component.types.includes(type))
    ?.long_name ?? null
}

function extractComponents(components: GoogleAddressComponent[]) {
  return {
    city:
      findComponent(components, 'locality') ??
      findComponent(components, 'administrative_area_level_2'),
    area:
      findComponent(components, 'sublocality') ??
      findComponent(components, 'sublocality_level_1') ??
      findComponent(components, 'neighborhood'),
    pincode: findComponent(components, 'postal_code'),
    state: findComponent(components, 'administrative_area_level_1'),
    country: findComponent(components, 'country'),
  }
}

function mapGeocodeResult(result: GoogleGeocodeResult) {
  return {
    formattedAddress: result.formatted_address,
    placeId: result.place_id,
    latitude: result.geometry.location.lat,
    longitude: result.geometry.location.lng,
    components: extractComponents(result.address_components),
  }
}

/**
 * Proxies Google Places Autocomplete. Flattened to just what an address
 * input needs: a place id to resolve later via `geocodePlace`/geocode, plus
 * a two-line label for the dropdown.
 */
async function autocompletePlaces(input: {
  query: string
  sessionToken?: string
  language?: string
  regionBias?: string
}) {
  const payload = await callGooglePlaces<GooglePlacesAutocompleteResponse>(
    '/places:autocomplete',
    {
      input: input.query,
      sessionToken: input.sessionToken,
      languageCode: input.language,
      includedRegionCodes: input.regionBias ? [input.regionBias] : undefined,
    },
  )

  return {
    predictions: (payload.suggestions ?? [])
      .map((suggestion) => suggestion.placePrediction)
      .filter((prediction): prediction is GooglePlacePrediction => Boolean(prediction?.placeId))
      .map((prediction) => {
        const description = prediction.text?.text ?? ''

        return {
          placeId: prediction.placeId as string,
          description,
          mainText: prediction.structuredFormat?.mainText?.text ?? description,
          secondaryText: prediction.structuredFormat?.secondaryText?.text ?? null,
        }
      }),
  }
}

/**
 * Proxies Google Geocoding (forward: free-text address -> coordinates).
 */
async function geocodeAddress(address: string) {
  const payload = await callGoogleMaps<GoogleGeocodeResponse>('/geocode/json', {
    address,
  })

  const [result] = payload.results

  return {
    result: result ? mapGeocodeResult(result) : null,
  }
}

/**
 * Proxies Google Geocoding (reverse: coordinates -> formatted address +
 * components), used for "use my current location" and the
 * draggable-pin-confirm step.
 */
async function reverseGeocode(latitude: number, longitude: number) {
  const payload = await callGoogleMaps<GoogleGeocodeResponse>('/geocode/json', {
    latlng: `${latitude},${longitude}`,
  })

  const [result] = payload.results

  return {
    result: result ? mapGeocodeResult(result) : null,
  }
}

export { autocompletePlaces, geocodeAddress, reverseGeocode }
