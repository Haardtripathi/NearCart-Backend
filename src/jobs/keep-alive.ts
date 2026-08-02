import { schedule } from 'node-cron'

/**
 * Render's free tier spins a web service down after ~15 minutes with no inbound HTTP request.
 * Self-pinging (and pinging the sibling app) on a tighter interval keeps both warm. Pinging the
 * sibling too means either service's cron can revive the other if one instance's own cron ever
 * fails to fire (e.g. mid-restart).
 */
const KEEP_ALIVE_URLS = [
  'https://nearcart-backend.onrender.com/api/health',
  'https://nearcart-inventory-backend.onrender.com/api/health',
]

const REQUEST_TIMEOUT_MS = 20_000

async function pingOnce(url: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, { signal: controller.signal })
    console.log(`[keep-alive] ${url} -> ${response.status}`)
  } catch (error) {
    // A sleeping Render instance can take 30-60s to cold-start and may time out the first
    // ping — that's expected and not a real failure, so this only warns, never throws.
    console.warn(`[keep-alive] ping failed for ${url}`, error)
  } finally {
    clearTimeout(timeout)
  }
}

/** Registers the every-10-minutes self/sibling ping. Called once at server startup, production only. */
export function registerKeepAlivePing(): void {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[keep-alive] Skipped outside production.')
    return
  }

  schedule('*/10 * * * *', () => {
    void Promise.all(KEEP_ALIVE_URLS.map(pingOnce))
  })

  console.log(`[keep-alive] Registered every-10-min ping for: ${KEEP_ALIVE_URLS.join(', ')}`)
}
