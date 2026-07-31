import 'dotenv/config'

import app from './app'
import env from './config/env'
import prisma from './lib/prisma'
import { ensureBootstrapAdmin } from './services/bootstrap.service'

async function startServer(): Promise<void> {
  try {
    await ensureBootstrapAdmin()
  } catch (error) {
    // Don't let a transient DB/network hiccup during admin bootstrap take down the whole
    // process — the HTTP server (health checks, and any DB-independent routes) should still
    // come up. ensureBootstrapAdmin() is safe to retry on a later restart.
    console.error(
      '[NearKart] Admin bootstrap failed (continuing to start the server anyway):',
      error,
    )
  }

  try {
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
