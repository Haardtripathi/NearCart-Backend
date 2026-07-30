import 'dotenv/config'

import app from './app'
import env from './config/env'
import prisma from './lib/prisma'
import { ensureBootstrapAdmin } from './services/bootstrap.service'

// TEMP DIAGNOSTIC (Turso 401 on Render) — remove once resolved. Never logs the full token.
function logDatabaseEnvFingerprint(): void {
  const token = process.env.DATABASE_AUTH_TOKEN ?? ''
  console.log('[boot] DATABASE_URL:', JSON.stringify(process.env.DATABASE_URL ?? ''))
  console.log(
    `[boot] DATABASE_AUTH_TOKEN: len=${token.length} head=${token.slice(0, 10)} tail=${token.slice(-10)}`,
  )
}

async function startServer(): Promise<void> {
  try {
    logDatabaseEnvFingerprint()

    await ensureBootstrapAdmin()

    const server = app.listen(env.port, () => {
      console.log(`${env.appName} listening on port ${env.port}`)
    })

    const shutdown = (signal: NodeJS.Signals): void => {
      console.log(`[NearKart] ${signal} received. Closing HTTP server.`)

      server.close((error) => {
        void prisma
          .$disconnect()
          .catch((disconnectError) => {
            console.error(
              '[NearKart] Error while disconnecting Prisma during shutdown',
              disconnectError,
            )
          })
          .finally(() => {
            if (error) {
              console.error('[NearKart] Error while closing HTTP server', error)
              process.exit(1)
            }

            process.exit(0)
          })
      })
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    console.error('Failed to start NearKart backend', error)
    process.exit(1)
  }
}

void startServer()
