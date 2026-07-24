import { Router } from 'express'

import {
  autocompleteHandler,
  geocodeHandler,
  reverseGeocodeHandler,
} from '../controllers/location.controller'
import { publicApiRateLimiter } from '../middleware/rateLimit'

const router = Router()

// Public (no auth) but rate-limited — these proxy Google Maps Platform so
// the API key never reaches the browser, and the limiter protects that
// key's quota from abuse.
router.get('/location/autocomplete', publicApiRateLimiter, autocompleteHandler)
router.get('/location/geocode', publicApiRateLimiter, geocodeHandler)
router.get(
  '/location/reverse-geocode',
  publicApiRateLimiter,
  reverseGeocodeHandler,
)

export default router
