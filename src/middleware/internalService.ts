import crypto from 'crypto'

import type { NextFunction, Request, Response } from 'express'

import env from '../config/env'
import { createHttpError } from '../utils/httpError'

/**
 * Guards inbound service-to-service calls FROM NearCart-Inventory (the reverse notification
 * webhook — see routes/internal.routes.ts). Mirrors NearCart-Inventory's own
 * requireInternalServiceAuth middleware exactly (same header name, same bearer fallback) and
 * checks against the SAME shared secret both sides already use for the outbound marketplace
 * bridge call (env.inventoryInternalToken here === Inventory's MARKETPLACE_INTERNAL_TOKEN) — one
 * shared secret authenticates both directions, no new env var needed.
 */
function readInternalToken(request: Request): string | null {
  const headerToken = request.headers['x-internal-service-token']

  if (typeof headerToken === 'string' && headerToken.trim().length > 0) {
    return headerToken.trim()
  }

  const authorization = request.headers.authorization

  if (authorization?.startsWith('Bearer ')) {
    const bearerToken = authorization.slice(7).trim()

    if (bearerToken.length > 0) {
      return bearerToken
    }
  }

  return null
}

/**
 * Constant-time string comparison for the shared secret. NearCart-Inventory's own
 * `requireInternalServiceAuth` (the middleware this one mirrors) uses a plain `!==`, which is a
 * real (if minor) timing side-channel — this file doesn't need to copy that weakness just
 * because the sibling repo has it. Mirrors the `safeCompareHashes` pattern already used in
 * `otp.service.ts`: falls back to `false` on a length mismatch rather than throwing, since
 * `crypto.timingSafeEqual` requires equal-length buffers.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')

  if (bufferA.length !== bufferB.length) {
    return false
  }

  return crypto.timingSafeEqual(bufferA, bufferB)
}

function requireInternalServiceAuth(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const configuredToken = env.inventoryInternalToken.trim()

  if (!configuredToken) {
    next(createHttpError(500, 'Inventory internal token is not configured'))
    return
  }

  const providedToken = readInternalToken(request)

  if (!providedToken || !timingSafeEqualStrings(providedToken, configuredToken)) {
    next(createHttpError(403, 'Invalid internal service token'))
    return
  }

  next()
}

export { requireInternalServiceAuth }
