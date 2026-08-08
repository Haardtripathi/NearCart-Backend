import { getRedisClient } from '../config/redis'

interface InMemoryEntry {
  value: string
  expiresAt: number
}

const memoryStore = new Map<string, InMemoryEntry>()

function pruneExpired(key: string): void {
  const entry = memoryStore.get(key)

  if (entry && entry.expiresAt <= Date.now()) {
    memoryStore.delete(key)
  }
}

/**
 * Minimal string key/value store with TTL, used for OTP codes and resend
 * cooldowns. Backed by Redis (via REDIS_URL) when available; otherwise falls
 * back to an in-process Map so the OTP flow still works in local dev/tests
 * without a Redis server running. The in-memory fallback is single-instance
 * only — fine for dev, not a substitute for Redis behind multiple instances
 * in production.
 */
async function kvSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient()

  if (redis) {
    await redis.set(key, value, 'EX', ttlSeconds)
    return
  }

  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
}

async function kvGet(key: string): Promise<string | null> {
  const redis = getRedisClient()

  if (redis) {
    return redis.get(key)
  }

  pruneExpired(key)
  return memoryStore.get(key)?.value ?? null
}

/**
 * Atomic "set if not already present" — the primitive a short-lived mutual-exclusion lock needs
 * (see `orders.service.ts`'s checkout lock, added after live testing showed two concurrent
 * `POST /orders` calls for the same customer — a fast double-tap on "place order", or any client
 * that fires the request twice before disabling its button — both succeed and create two real,
 * inventory-synced orders; there was no server-side guard against that at all). A plain
 * `kvGet` + `kvSet` pair is NOT atomic (two concurrent callers can both see "no key" before either
 * writes), which is exactly the same class of race `recordCouponRedemption` in `coupon.service.ts`
 * had to guard against with a conditional `updateMany` — this is the KV-store equivalent for a
 * lock rather than a counter. Returns `true` when this call was the one that created the key
 * (lock acquired), `false` when the key already existed (lock held by someone else).
 */
async function kvSetNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedisClient()

  if (redis) {
    const result = await redis.set(key, value, 'EX', ttlSeconds, 'NX')
    return result === 'OK'
  }

  pruneExpired(key)

  if (memoryStore.has(key)) {
    return false
  }

  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  return true
}

async function kvDel(key: string): Promise<void> {
  const redis = getRedisClient()

  if (redis) {
    await redis.del(key)
    return
  }

  memoryStore.delete(key)
}

async function kvIncr(key: string, ttlSeconds: number): Promise<number> {
  const redis = getRedisClient()

  if (redis) {
    const next = await redis.incr(key)

    if (next === 1) {
      await redis.expire(key, ttlSeconds)
    }

    return next
  }

  pruneExpired(key)
  const existing = memoryStore.get(key)
  const nextCount = existing ? Number.parseInt(existing.value, 10) + 1 : 1

  memoryStore.set(key, {
    value: String(nextCount),
    expiresAt: existing?.expiresAt ?? Date.now() + ttlSeconds * 1000,
  })

  return nextCount
}

async function kvTtlRemaining(key: string): Promise<number> {
  const redis = getRedisClient()

  if (redis) {
    const ttl = await redis.ttl(key)
    return ttl > 0 ? ttl : 0
  }

  pruneExpired(key)
  const entry = memoryStore.get(key)

  if (!entry) {
    return 0
  }

  return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))
}

export { kvDel, kvGet, kvIncr, kvSet, kvSetNx, kvTtlRemaining }
