const dotenv = require('dotenv')

dotenv.config()

const app = require('./src/app')
const env = require('./src/config/env')
const { ensureBootstrapAdmin } = require('./src/services/bootstrap.service')

async function startServer() {
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
