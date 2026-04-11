const dotenv = require('dotenv')

dotenv.config()

const app = require('./src/app')
const env = require('./src/config/env')

app.listen(env.port, () => {
  console.log(`${env.appName} listening on port ${env.port}`)
})
