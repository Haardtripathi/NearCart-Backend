import type { Request, RequestHandler } from 'express'
import type { UserRole } from '@prisma/client'

import prisma from '../lib/prisma'
import { authUserInclude } from '../types/auth'
import { createHttpError } from '../utils/httpError'
import { verifyAccessToken } from '../utils/jwt'

function getBearerToken(request: Request): string | null {
  const authorizationHeader = request.headers.authorization || ''

  if (!authorizationHeader.startsWith('Bearer ')) {
    return null
  }

  return authorizationHeader.slice(7).trim()
}

async function resolveAuthenticatedUser(
  request: Request,
  isOptional: boolean,
): Promise<Express.Request['auth']> {
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
    include: authUserInclude,
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

const requireAuth: RequestHandler = async (request, _response, next) => {
  try {
    await resolveAuthenticatedUser(request, false)
    next()
  } catch (error) {
    next(error)
  }
}

const optionalAuth: RequestHandler = async (request, _response, next) => {
  try {
    await resolveAuthenticatedUser(request, true)
    next()
  } catch (error) {
    next(error)
  }
}

function requireRole(...roles: UserRole[]): RequestHandler {
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

export { optionalAuth, requireAuth, requireRole }
