import 'dotenv/config'

import app from './src/app'
import env from './src/config/env'
import { ensureBootstrapAdmin } from './src/services/bootstrap.service'

async function startServer(): Promise<void> {
  try {
    await ensureBootstrapAdmin()

    app.listen(env.port, () => {
      console.log(`${env.appName} listening on port ${env.port}`)
    })
  } catch (error) {
    console.error('Failed to start NearCart backend', error)
    process.exit(1)
  }
}

void startServer()
