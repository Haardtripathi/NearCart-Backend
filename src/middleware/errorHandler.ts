import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'

import type { HttpError } from '../types/http'

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.error(error)
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      message: 'Invalid request payload',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
    return
  }

  const httpError = error as HttpError
  const statusCode =
    httpError.status ||
    (response.statusCode >= 400 ? response.statusCode : 500)

  response.status(statusCode).json({
    message: httpError.message || 'Internal Server Error',
    ...(httpError.details ? { details: httpError.details } : {}),
  })
}

export default errorHandler
