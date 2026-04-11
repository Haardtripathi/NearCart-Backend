const env = require('./env')

const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

module.exports = {
  origin(origin, callback) {
    const isAllowedLocalOrigin =
      env.nodeEnv !== 'production' && localOriginPattern.test(origin || '')

    if (!origin || env.corsOrigins.includes(origin) || isAllowedLocalOrigin) {
      callback(null, true)
      return
    }

    const corsError = new Error(`Origin ${origin} is not allowed by CORS`)
    corsError.status = 403

    callback(corsError)
  },
  credentials: true,
}
