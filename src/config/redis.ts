import Redis from 'ioredis'

import env from './env'

let client: Redis | null = null
let attemptedConnection = false
let loggedUnavailable = false

/**
 * Lazily creates (at most once) an ioredis client for REDIS_URL.
 *
 * Returns `null` when REDIS_URL is not configured, or once the client has
 * failed to connect — callers (rate limiting, OTP storage) are expected to
 * fall back to an in-memory strategy when this returns `null` so that local
 * development works without a Redis server running.
 */
function getRedisClient(): Redis | null {
  if (!env.redisUrl) {
    return null
  }

  if (!attemptedConnection) {
    attemptedConnection = true

    client = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      reconnectOnError: () => false,
    })

    client.on('error', (error: Error) => {
      if (!loggedUnavailable) {
        loggedUnavailable = true
        console.warn(
          `[NearKart] Redis is unavailable (${error.message}). Falling back to in-memory rate limiting and OTP storage.`,
        )
      }
    })

    client.connect().catch(() => {
      // Swallow — the 'error' handler above already logs a single warning.
    })
  }

  return client
}

export { getRedisClient }
