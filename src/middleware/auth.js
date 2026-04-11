const prisma = require('../lib/prisma')
const { verifyAccessToken } = require('../utils/jwt')
const { createHttpError } = require('../utils/httpError')

function getBearerToken(request) {
  const authorizationHeader = request.headers.authorization || ''

  if (!authorizationHeader.startsWith('Bearer ')) {
    return null
  }

  return authorizationHeader.slice(7).trim()
}

async function resolveAuthenticatedUser(request, isOptional) {
  const token = getBearerToken(request)

  if (!token) {
    if (isOptional) {
      request.auth = null
      return null
    }

    throw createHttpError(401, 'Authentication required')
  }

  let payload

  try {
    payload = verifyAccessToken(token)
  } catch {
    if (isOptional) {
      request.auth = null
      return null
    }

    throw createHttpError(401, 'Invalid or expired access token')
  }

  const user = await prisma.user.findUnique({
    where: {
      id: payload.sub,
    },
    include: {
      customerProfile: {
        include: {
          defaultAddress: true,
        },
      },
      shopOwnerProfile: true,
    },
  })

  if (!user || !user.isActive) {
    if (isOptional) {
      request.auth = null
      return null
    }

    throw createHttpError(401, 'Your session is no longer active')
  }

  request.auth = {
    userId: user.id,
    role: user.role,
    user,
  }

  return request.auth
}

async function requireAuth(request, _response, next) {
  try {
    await resolveAuthenticatedUser(request, false)
    next()
  } catch (error) {
    next(error)
  }
}

async function optionalAuth(request, _response, next) {
  try {
    await resolveAuthenticatedUser(request, true)
    next()
  } catch (error) {
    next(error)
  }
}

function requireRole(...roles) {
  return (request, _response, next) => {
    if (!request.auth?.user) {
      next(createHttpError(401, 'Authentication required'))
      return
    }

    if (!roles.includes(request.auth.user.role)) {
      next(createHttpError(403, 'You do not have access to this resource'))
      return
    }

    next()
  }
}

module.exports = {
  optionalAuth,
  requireAuth,
  requireRole,
}
