/**
 * Vitest `globalSetup` — runs exactly once for the whole `vitest run` invocation, in its own
 * process (separate from the test files' module graph, so it can't see `vi.mock` etc. — it's
 * pure DB lifecycle plumbing).
 *
 * Responsibilities:
 *  1. Load `.env.test` and hard-verify `DATABASE_URL` is a local `file:` URL — this is the last
 *     line of defense before anything runs `prisma db push`, since that command is destructive
 *     against whatever DATABASE_URL it's pointed at. NEVER remove this guard.
 *  2. Push the current `prisma/schema.prisma` onto that disposable file DB once, via a child
 *     process with an explicit env override (mirrors how `prisma.config.ts`'s own adapter reads
 *     `process.env.DATABASE_URL` — the schema itself declares no `datasource.url`, so the CLI
 *     must be told the target DB through the environment, not the schema file).
 *  3. Return a teardown function that deletes the `.db` file (and SQLite's `-journal`/`-wal`/
 *     `-shm` sidecar files) after the whole suite finishes, so no state leaks between runs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

import dotenv from 'dotenv'

export default async function globalSetup(): Promise<() => Promise<void>> {
  const envPath = path.resolve(process.cwd(), '.env.test')
  const parsedEnv = dotenv.config({ path: envPath })

  if (parsedEnv.error || !parsedEnv.parsed) {
    throw new Error(
      `[global-setup] Failed to load .env.test at ${envPath}: ${parsedEnv.error?.message ?? 'no vars parsed'}`,
    )
  }

  const databaseUrl = parsedEnv.parsed.DATABASE_URL

  if (!databaseUrl || !databaseUrl.toLowerCase().startsWith('file:')) {
    throw new Error(
      `[global-setup] Refusing to run \`prisma db push\`: DATABASE_URL in .env.test must start ` +
        `with "file:" (a disposable local test DB), got: ${String(databaseUrl)}. This guard exists ` +
        `specifically to make sure this suite can never touch the real production Turso database.`,
    )
  }

  const dbFilePath = path.resolve(process.cwd(), databaseUrl.replace(/^file:/i, ''))

  console.log(`[global-setup] Pushing prisma/schema.prisma to disposable test DB: ${databaseUrl}`)

  execFileSync(
    'npx',
    [
      'prisma',
      'db',
      'push',
      '--accept-data-loss',
      '--schema=./prisma/schema.prisma',
      // Prisma 7's `db push` reads the datasource URL from `prisma.config.ts`'s `adapter`
      // callback, not from an env var passed to the child process — that callback resolves
      // `DATABASE_URL` at config-load time inside the `prisma` CLI's own process, which doesn't
      // inherit this `execFileSync` call's env override in time. `--url` is the CLI's documented
      // override for exactly this case (see `npx prisma db push --help`), and takes precedence
      // over whatever the config file/adapter would otherwise resolve.
      `--url=${databaseUrl}`,
    ],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        ...parsedEnv.parsed,
        // Explicit, not just spread — this is the one value this whole guard exists to pin down.
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'test',
      },
    },
  )

  console.log('[global-setup] Test DB schema ready.')

  return async function teardown(): Promise<void> {
    const sidecarSuffixes = ['', '-journal', '-wal', '-shm']

    for (const suffix of sidecarSuffixes) {
      const filePath = `${dbFilePath}${suffix}`

      if (existsSync(filePath)) {
        rmSync(filePath, { force: true })
      }
    }

    console.log('[global-setup] Disposable test DB deleted.')
  }
}
