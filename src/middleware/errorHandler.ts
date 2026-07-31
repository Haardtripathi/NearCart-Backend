import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'

import env from '../config/env'
import type { HttpError } from '../types/http'
import { buildMeta } from '../utils/response'

const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
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
  // `status` is only ever set by createHttpError()/cors.ts — i.e. an error a route/service
  // deliberately raised with a message that's safe to show a client. Anything else (a raw
  // Prisma/driver/library exception, a bug) is "unknown" and must not have its raw .message
  // echoed back to the client in production — that can leak internal details (DB error text,
  // stack-derived strings, etc.). It's still shown in development for local debugging.
  const isKnownHttpError = typeof httpError.status === 'number'
  const statusCode =
    httpError.status ||
    (response.statusCode >= 400 ? response.statusCode : 500)

  if (statusCode >= 500) {
    // Always log server errors server-side. This used to be gated on `nodeEnv !== 'production'`,
    // which meant production 500s left no server-side trace at all — the raw error message sent
    // to the client was the only record of what happened.
    console.error(`[NearKart] Unhandled error on ${request.method} ${request.originalUrl}`, error)
  }

  const clientMessage =
    isKnownHttpError || env.nodeEnv !== 'production'
      ? httpError.message || 'Internal Server Error'
      : 'Internal Server Error'

  response.status(statusCode).json({
    success: false,
    message: clientMessage,
    ...(httpError.details ? { details: httpError.details } : {}),
    meta: buildMeta(),
  })
}

export default errorHandler
