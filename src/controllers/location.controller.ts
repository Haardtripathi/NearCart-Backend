import type { NextFunction, Request, Response } from 'express'

import { autocompletePlaces, geocodeAddress, geocodePlaceId, reverseGeocode } from '../services/maps.service'
import { getTimestamp } from '../utils/time'
import {
  autocompleteQuerySchema,
  geocodeQuerySchema,
  reverseGeocodeQuerySchema,
} from '../validation/location.validation'

async function autocompleteHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = autocompleteQuerySchema.parse(request.query)
    const result = await autocompletePlaces({
      query: query.input,
      sessionToken: query.sessionToken,
      language: query.language,
      regionBias: query.region,
      latitude: query.lat,
      longitude: query.lng,
      radiusMeters: query.radiusMeters,
    })

    response.status(200).json({
      ...result,
      meta: { source: 'google-maps', timestamp: getTimestamp() },
    })
  } catch (error) {
    next(error)
  }
}

async function geocodeHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = geocodeQuerySchema.parse(request.query)
    const result = query.placeId
      ? await geocodePlaceId(query.placeId)
      : await geocodeAddress(query.address as string)

    response.status(200).json({
      ...result,
      meta: { source: 'google-maps', timestamp: getTimestamp() },
    })
  } catch (error) {
    next(error)
  }
}

async function reverseGeocodeHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = reverseGeocodeQuerySchema.parse(request.query)
    const result = await reverseGeocode(query.lat, query.lng)

    response.status(200).json({
      ...result,
      meta: { source: 'google-maps', timestamp: getTimestamp() },
    })
  } catch (error) {
    next(error)
  }
}

export { autocompleteHandler, geocodeHandler, reverseGeocodeHandler }
