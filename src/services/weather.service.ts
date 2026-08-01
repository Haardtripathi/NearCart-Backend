import env from '../config/env'

const OPEN_WEATHER_BASE_URL = 'https://api.openweathermap.org/data/2.5/weather'

// A mild default penalty, not zero — represents genuine uncertainty about
// current conditions when we have no live weather signal (either because
// WEATHER_API_KEY is unset, or because the live call itself failed/returned
// something we don't recognize). A flaky/unconfigured weather source must
// never block or slow down shop browsing, so every failure path below
// resolves to this same stub rather than throwing.
const STUB_MULTIPLIER = 1.1
const STUB_CONDITION = 'unknown'

const SEVERE_CONDITIONS = new Set(['Thunderstorm', 'Snow'])
const MODERATE_CONDITIONS = new Set(['Rain', 'Drizzle'])

interface WeatherImpact {
  conditionMultiplier: number
  condition: string
}

interface OpenWeatherCurrentResponse {
  weather?: Array<{ main?: string }>
}

let hasLoggedStubMode = false

/**
 * Logs the "running in stub mode" notice exactly once per process, not per
 * call — this is expected to be invoked on every shop-list/detail request,
 * so per-call logging would spam the console.
 */
function logStubModeOnce(): void {
  if (hasLoggedStubMode) {
    return
  }

  hasLoggedStubMode = true
  console.info(
    '[NearKart] WEATHER_API_KEY is not set — weather.service is running in stub mode ' +
      `(fixed ${STUB_MULTIPLIER}x delivery-time multiplier, condition="${STUB_CONDITION}").`,
  )
}

function conditionToImpact(main: string | undefined | null): WeatherImpact {
  if (!main) {
    return { conditionMultiplier: STUB_MULTIPLIER, condition: STUB_CONDITION }
  }

  if (SEVERE_CONDITIONS.has(main)) {
    return { conditionMultiplier: 1.4, condition: main }
  }

  if (MODERATE_CONDITIONS.has(main)) {
    return { conditionMultiplier: 1.2, condition: main }
  }

  return { conditionMultiplier: 1.0, condition: main }
}

/**
 * Looks up current weather for a coordinate and maps it to a delivery-time
 * multiplier. Mirrors `maps.service.ts`'s `callGoogleMaps` pattern (a thin
 * `fetch`-based proxy with the same "no explicit timeout, just catch network
 * failures" convention that file uses) but never throws — the caller
 * (`delivery-eta.service.ts`) folds this straight into an ETA number, and a
 * weather-API hiccup must degrade to the stub value rather than break shop
 * browsing.
 */
async function getWeatherImpact(
  latitude: number,
  longitude: number,
): Promise<WeatherImpact> {
  if (!env.weatherApiKey) {
    logStubModeOnce()
    return { conditionMultiplier: STUB_MULTIPLIER, condition: STUB_CONDITION }
  }

  const url = new URL(OPEN_WEATHER_BASE_URL)
  url.searchParams.set('lat', String(latitude))
  url.searchParams.set('lon', String(longitude))
  url.searchParams.set('appid', env.weatherApiKey)
  url.searchParams.set('units', 'metric')

  try {
    const response = await fetch(url.toString())

    if (!response.ok) {
      return { conditionMultiplier: STUB_MULTIPLIER, condition: STUB_CONDITION }
    }

    const payload = (await response.json()) as OpenWeatherCurrentResponse

    return conditionToImpact(payload.weather?.[0]?.main)
  } catch {
    return { conditionMultiplier: STUB_MULTIPLIER, condition: STUB_CONDITION }
  }
}

// Flat delivery surcharge (in rupees, matching every other money field in this backend which is
// stored/returned as an Int) for bad-weather deliveries — kept in this file, deriving from the
// SAME `SEVERE_CONDITIONS`/`MODERATE_CONDITIONS` sets above, so the condition->severity mapping
// has exactly one source of truth shared by the ETA multiplier (`conditionToImpact`) and this
// fee. Anything outside those two sets — including the `STUB_CONDITION`/`'unknown'` fallback used
// on every failure/unconfigured path above — charges nothing, mirroring this file's existing
// fail-safe posture: a weather hiccup must never cost the customer money.
const SEVERE_WEATHER_SURCHARGE = 40
const MODERATE_WEATHER_SURCHARGE = 20

function getWeatherFeeForCondition(condition: string): number {
  if (SEVERE_CONDITIONS.has(condition)) {
    return SEVERE_WEATHER_SURCHARGE
  }

  if (MODERATE_CONDITIONS.has(condition)) {
    return MODERATE_WEATHER_SURCHARGE
  }

  return 0
}

export { getWeatherFeeForCondition, getWeatherImpact }
export type { WeatherImpact }
