import { getRedisClient } from '../config/redis'
import { kvGet, kvSet } from './kvStore'

/**
 * Read-through cache for slow-changing, read-heavy DATABASE results — shop directory listings,
 * category counts, rating aggregates. Never for live stock, availability or price: those come
 * from the NearCart-Inventory bridge on every call by design, and a stale number there is a wrong
 * order, not a slow page.
 *
 * Backed by `kvStore` (Redis when REDIS_URL is set, so every instance shares one entry) but with
 * its own in-process fallback Map rather than kvStore's. kvStore's Map is shared with OTP codes,
 * checkout locks and refresh-token locks and is deliberately unbounded — evicting one of those to
 * make room for a cached shop list would be a correctness bug, whereas evicting a cached list is
 * just a cache miss. So cached payloads get their own bounded map, and only the Redis path is
 * shared.
 */

const MEMORY_CACHE_MAX_ENTRIES = 500

const memoryCache = new Map<string, { value: string; expiresAt: number }>()

function memoryCacheGet(key: string): string | null {
  const entry = memoryCache.get(key)

  if (!entry) {
    return null
  }

  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key)
    return null
  }

  return entry.value
}

function memoryCacheSet(key: string, value: string, ttlSeconds: number): void {
  if (memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES && !memoryCache.has(key)) {
    // Map iterates in insertion order, so the first key is the oldest write — a good-enough
    // eviction policy for a cache whose entries all expire within minutes anyway.
    const oldestKey = memoryCache.keys().next().value

    if (oldestKey !== undefined) {
      memoryCache.delete(oldestKey)
    }
  }

  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
}

/**
 * Bumped whenever a write changes which shops are publicly visible, or how they present. Cache
 * keys carry it, so a bump instantly orphans every cached shop-directory entry instead of waiting
 * out its TTL — that is what makes "shop owner marks the shop closed" show up on the customer's
 * next refresh rather than up to a TTL later. It is per-process: with Redis and several
 * instances, the instance that handled the write is immediately consistent and the others fall
 * back to their TTL, which is why the TTLs stay short.
 */
let shopDirectoryGeneration = 0

function bumpShopDirectoryGeneration(): void {
  shopDirectoryGeneration += 1
}

function shopDirectoryCacheKey(name: string, parts: unknown): string {
  return `cache:v1:${name}:g${shopDirectoryGeneration}:${JSON.stringify(parts)}`
}

async function cacheGet(key: string): Promise<string | null> {
  if (getRedisClient()) {
    return kvGet(key)
  }

  return memoryCacheGet(key)
}

async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (getRedisClient()) {
    await kvSet(key, value, ttlSeconds)
    return
  }

  memoryCacheSet(key, value, ttlSeconds)
}

/**
 * Returns the cached value for `key`, or runs `load()` and caches its result for `ttlSeconds`.
 *
 * Fail-open in both directions: a cache backend that errors (Redis down mid-request) degrades to
 * calling `load()` and returning a live answer, never to a failed request. `load()`'s own errors
 * propagate untouched — a cache must not turn a 404 into a 200.
 *
 * The value makes a round trip through JSON, so only cache plain data: a `Date` would come back
 * as a string on a hit and stay a `Date` on a miss, which is exactly the kind of difference that
 * shows up as a bug months later. Every current caller returns scalars.
 *
 * Concurrent misses for the same key all run `load()` — no single-flight lock. That is deliberate
 * at these TTLs and query costs; revisit if something expensive is ever cached through here.
 */
async function getCachedJson<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await cacheGet(key)

    if (cached !== null) {
      return JSON.parse(cached) as T
    }
  } catch (error) {
    console.warn(
      `[NearKart] Cache read failed for ${key} (serving a live result instead):`,
      error instanceof Error ? error.message : error,
    )
  }

  const value = await load()

  try {
    await cacheSet(key, JSON.stringify(value), ttlSeconds)
  } catch (error) {
    console.warn(
      `[NearKart] Cache write failed for ${key}:`,
      error instanceof Error ? error.message : error,
    )
  }

  return value
}

export { bumpShopDirectoryGeneration, getCachedJson, shopDirectoryCacheKey }
