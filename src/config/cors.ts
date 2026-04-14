import type { CorsOptions } from 'cors'

import env from './env'
import type { HttpError } from '../types/http'

const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    const isAllowedLocalOrigin =
      env.nodeEnv !== 'production' && localOriginPattern.test(origin || '')

    if (!origin || env.corsOrigins.includes(origin) || isAllowedLocalOrigin) {
      callback(null, true)
      return
    }

    const corsError = new Error(
      `Origin ${origin} is not allowed by CORS`,
    ) as HttpError
    corsError.status = 403

    callback(corsError)
  },
  credentials: true,
}

export default corsOptions
