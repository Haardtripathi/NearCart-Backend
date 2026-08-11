/**
 * Vitest `setupFiles` entry — runs before each test file, in that file's own module graph
 * (unlike `tests/global-setup.ts`, which runs once for the whole run in a separate process).
 *
 * This must be the very first thing that touches env vars in a test file's module graph: `src/
 * config/env.ts` reads `process.env` at import time (module-level, not lazily), so `.env.test`
 * has to be loaded — with override — before anything under `src/` gets imported anywhere
 * (directly by a spec file, or transitively via a test helper).
 */
import path from 'node:path'

import dotenv from 'dotenv'

const envPath = path.resolve(process.cwd(), '.env.test')
const parsedEnv = dotenv.config({ path: envPath, override: true })

if (parsedEnv.error || !parsedEnv.parsed) {
  throw new Error(
    `[tests/setup] Failed to load .env.test at ${envPath}: ${parsedEnv.error?.message ?? 'no vars parsed'}`,
  )
}

// Hard guard rail: this suite must never be able to run against the real production Turso
// `libsql://` database configured in the real `.env`. If DATABASE_URL isn't a local `file:` URL
// at this point, something is badly wrong with the test env setup — refuse to run at all rather
// than risk any test (register/order/db push) touching production data.
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.toLowerCase().startsWith('file:')) {
  throw new Error(
    `[tests/setup] Refusing to run tests: DATABASE_URL must start with "file:" (a disposable ` +
      `local test DB), got: ${String(process.env.DATABASE_URL)}. Check .env.test.`,
  )
}
