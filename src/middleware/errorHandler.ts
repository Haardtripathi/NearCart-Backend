import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'

import env from '../config/env'
import type { HttpError } from '../types/http'
import { buildMeta } from '../utils/response'

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      success: false,
      message: 'Invalid request payload',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      meta: buildMeta(),
    })
    return
  }

  const httpError = error as HttpError
  const statusCode =
    httpError.status ||
    (response.statusCode >= 400 ? response.statusCode : 500)

  if (env.nodeEnv !== 'production' && statusCode >= 500) {
    console.error(error)
  }

  response.status(statusCode).json({
    success: false,
    message: httpError.message || 'Internal Server Error',
    ...(httpError.details ? { details: httpError.details } : {}),
    meta: buildMeta(),
  })
}

export default errorHandler
