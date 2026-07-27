import type { NextFunction, Request, Response } from 'express'

import env from '../config/env'
import { buildMeta } from '../utils/response'
import {
  buildRefreshCookieOptions,
  getAuthenticatedUser,
  getRefreshTokenFromRequest,
  login,
  logout,
  refreshSession,
  registerCustomer,
  registerShopOwner,
} from '../services/auth.service'
import {
  loginSchema,
  registerCustomerSchema,
  registerShopOwnerSchema,
} from '../validation/auth.validation'

/**
 * Native (React Native) clients have no cookie jar, so they identify
 * themselves with this header to also receive the raw refresh token in the
 * JSON body. The cookie is still set unconditionally either way — harmless
 * for native (nothing reads it) and keeps the web flow byte-for-byte
 * unchanged.
 */
function isNativeClient(request: Request): boolean {
  const headerValue = request.headers['x-client-type']
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue

  return typeof value === 'string' && value.toLowerCase() === 'native'
}

function sendSessionResponse(
  request: Request,
  response: Response,
  session: Awaited<ReturnType<typeof login>>,
  statusCode = 200,
): void {
  response.cookie(
    env.authRefreshCookieName,
    session.refreshToken,
    buildRefreshCookieOptions(),
  )

  response.status(statusCode).json({
    user: session.user,
    accessToken: session.accessToken,
    meta: session.meta,
    ...(isNativeClient(request) ? { refreshToken: session.refreshToken } : {}),
  })
}

async function registerCustomerHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = registerCustomerSchema.parse(request.body)
    const session = await registerCustomer(payload)

    sendSessionResponse(request, response, session, 201)
  } catch (error) {
    next(error)
  }
}

async function registerShopOwnerHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = registerShopOwnerSchema.parse(request.body)
    const session = await registerShopOwner(payload)

    sendSessionResponse(request, response, session, 201)
  } catch (error) {
    next(error)
  }
}

async function loginHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payload = loginSchema.parse(request.body)
    const session = await login(payload)

    sendSessionResponse(request, response, session)
  } catch (error) {
    next(error)
  }
}

async function logoutHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const refreshTokenValue = getRefreshTokenFromRequest(request)

    await logout(refreshTokenValue)

    response.clearCookie(
      env.authRefreshCookieName,
      buildRefreshCookieOptions(),
    )

    response.status(200).json({
      success: true,
      meta: buildMeta(),
    })
  } catch (error) {
    next(error)
  }
}

async function meHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getAuthenticatedUser(request.auth!.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function refreshHandler(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const refreshTokenValue = getRefreshTokenFromRequest(request)
    const session = await refreshSession(refreshTokenValue)

    sendSessionResponse(request, response, session)
  } catch (error) {
    next(error)
  }
}

export {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerCustomerHandler,
  registerShopOwnerHandler,
}
