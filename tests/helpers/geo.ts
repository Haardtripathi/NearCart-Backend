/**
 * Deliberately NOT imported from `src/utils/geo.ts` — these are independent reimplementations of
 * the haversine distance formula and the delivery-fee clamp formula, used by
 * `tests/e2e/delivery-fee-formula.spec.ts` to compute an expected value from first principles.
 * If this file imported the real implementation instead, a bug introduced in
 * `computeDeliveryFee`/`haversineDistanceKm` could never be caught by these tests — the test
 * would just be comparing the source code to itself.
 */

const EARTH_RADIUS_KM = 6371

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function independentHaversineDistanceKm(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number {
  const deltaLat = toRadians(toLatitude - fromLatitude)
  const deltaLng = toRadians(toLongitude - fromLongitude)

  const lat1 = toRadians(fromLatitude)
  const lat2 = toRadians(toLatitude)

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return EARTH_RADIUS_KM * c
}

function independentClamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function independentComputeDeliveryFee(
  distanceKm: number,
  base: number,
  perKm: number,
  min: number,
  max: number,
): number {
  const rawFee = base + perKm * distanceKm
  return Math.round(independentClamp(rawFee, min, max))
}

export { independentClamp, independentComputeDeliveryFee, independentHaversineDistanceKm }
