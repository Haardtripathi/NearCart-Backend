import type { RequestHandler } from 'express'
import rateLimit, { type Options } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'

import { getRedisClient } from '../config/redis'

type PartialOptions = Partial<Options>

/**
 * Builds an express-rate-limit middleware. Uses a Redis-backed store when
 * REDIS_URL is configured (shared across instances in production);
 * otherwise falls back to express-rate-limit's built-in in-memory store so
 * limiting still works for a single-instance/local dev setup without Redis
 * running.
 *
 * Known limitation (shared with the sibling Inventory app's own reference
 * rate limiter): if REDIS_URL is configured but Redis becomes unreachable
 * after startup, requests to these routes will error until Redis recovers.
 * There is no per-request fail-open fallback — acceptable for now since the
 * failure mode is "Redis is down", which is already an ops-visible incident.
 */
function buildRateLimiter(options: PartialOptions): RequestHandler {
  const redis = getRedisClient()

  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    ...(redis
      ? {
          store: new RedisStore({
            prefix: `rl:${options.windowMs ?? 'default'}:`,
            sendCommand: (...args: string[]) =>
              redis.call(args[0] as string, ...args.slice(1)) as Promise<
                number | number[]
              >,
          }),
        }
      : {}),
  })
}

/**
 * Strict limiter for register/login — the most brute-forceable endpoints.
 * 20 requests / 15 minutes per IP.
 */
const authRateLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    message: 'Too many attempts. Please try again in a few minutes.',
  },
})

/**
 * Limiter for order creation (checkout) — generous enough for real
 * customers placing multiple orders, tight enough to blunt scripted abuse.
 * 30 requests / 15 minutes per IP.
 */
const orderCreateRateLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: 'Too many orders placed from this network. Please slow down.',
  },
})

/**
 * Limiter for OTP send/resend — separate from the general auth limiter
 * because the OTP service already enforces its own per-user cooldown; this
 * is a coarser per-IP backstop against email-bombing an address.
 */
const otpRateLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: 'Too many verification code requests. Please try again later.',
  },
})

/**
 * General-purpose limiter for other public/unauthenticated surfaces
 * (location/maps proxy, public catalog browsing) — generous, mainly to cap
 * abusive scripted traffic and protect the Google Maps API key's quota.
 */
const publicApiRateLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
})

export {
  authRateLimiter,
  orderCreateRateLimiter,
  otpRateLimiter,
  publicApiRateLimiter,
}
