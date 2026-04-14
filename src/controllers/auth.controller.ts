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

function sendSessionResponse(
  response: Response,
  session: Awaited<ReturnType<typeof login>>,
): void {
  response.cookie(
    env.authRefreshCookieName,
    session.refreshToken,
    buildRefreshCookieOptions(),
  )

  response.status(200).json({
    user: session.user,
    accessToken: session.accessToken,
    meta: session.meta,
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

    response.cookie(
      env.authRefreshCookieName,
      session.refreshToken,
      buildRefreshCookieOptions(),
    )

    response.status(201).json({
      user: session.user,
      accessToken: session.accessToken,
      meta: session.meta,
    })
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

    response.cookie(
      env.authRefreshCookieName,
      session.refreshToken,
      buildRefreshCookieOptions(),
    )

    response.status(201).json({
      user: session.user,
      accessToken: session.accessToken,
      meta: session.meta,
    })
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

    sendSessionResponse(response, session)
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

    sendSessionResponse(response, session)
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
