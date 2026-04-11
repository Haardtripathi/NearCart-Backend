const env = require('../config/env')
const {
  buildRefreshCookieOptions,
  getAuthenticatedUser,
  getRefreshTokenFromRequest,
  login,
  logout,
  refreshSession,
  registerCustomer,
  registerShopOwner,
} = require('../services/auth.service')
const { buildMeta } = require('../utils/response')
const {
  loginSchema,
  registerCustomerSchema,
  registerShopOwnerSchema,
} = require('../validation/auth.validation')

function sendSessionResponse(response, session) {
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

async function registerCustomerHandler(request, response, next) {
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

async function registerShopOwnerHandler(request, response, next) {
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

async function loginHandler(request, response, next) {
  try {
    const payload = loginSchema.parse(request.body)
    const session = await login(payload)

    sendSessionResponse(response, session)
  } catch (error) {
    next(error)
  }
}

async function logoutHandler(request, response, next) {
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

async function meHandler(request, response, next) {
  try {
    const result = await getAuthenticatedUser(request.auth.userId)

    response.status(200).json(result)
  } catch (error) {
    next(error)
  }
}

async function refreshHandler(request, response, next) {
  try {
    const refreshTokenValue = getRefreshTokenFromRequest(request)
    const session = await refreshSession(refreshTokenValue)

    sendSessionResponse(response, session)
  } catch (error) {
    next(error)
  }
}

module.exports = {
  loginHandler,
  logoutHandler,
  meHandler,
  refreshHandler,
  registerCustomerHandler,
  registerShopOwnerHandler,
}
