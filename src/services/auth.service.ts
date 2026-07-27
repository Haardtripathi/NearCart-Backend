import type { CookieOptions, Request } from 'express'

import env from '../config/env'
import prisma from '../lib/prisma'
import { authUserInclude, type AuthUser } from '../types/auth'
import { parseCookies } from '../utils/cookies'
import { createHttpError } from '../utils/httpError'
import { signAccessToken } from '../utils/jwt'
import { hashPassword, verifyPassword } from '../utils/password'
import { buildMeta } from '../utils/response'
import { mapSafeUser } from '../utils/serializers'
import { createRefreshTokenValue, hashToken } from '../utils/token'
import {
  getDashboardPathForRole,
  normalizeEmail,
  normalizeOptionalString,
} from '../utils/user'
import type {
  LoginInput,
  RegisterCustomerInput,
  RegisterShopOwnerInput,
} from '../validation/auth.validation'

function buildRefreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: env.nodeEnv === 'production' ? 'none' : 'lax',
    secure: env.nodeEnv === 'production',
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  }
}

function getRefreshTokenFromRequest(request: Request): string | null {
  const cookies = parseCookies(request.headers.cookie)
  const cookieToken = cookies[env.authRefreshCookieName]

  if (cookieToken) {
    return cookieToken
  }

  // Native clients (React Native) have no cookie jar, so the rotating
  // refresh cookie system is unreachable for them unless we also accept the
  // token from the request body. Cookie is checked first so nothing changes
  // for the existing web flow; this is purely a fallback for native.
  const bodyToken = (request.body as Record<string, unknown> | undefined)?.[
    'refreshToken'
  ]

  return typeof bodyToken === 'string' && bodyToken.trim().length > 0
    ? bodyToken
    : null
}

async function getUserForAuth(userId: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: {
      id: userId,
    },
    include: authUserInclude,
  })
}

function buildSessionResponse(
  user: AuthUser,
  accessToken: string,
  refreshExpiresAt: string,
) {
  return {
    user: mapSafeUser(user),
    accessToken,
    meta: buildMeta({
      role: user.role,
      dashboardPath: getDashboardPathForRole(user.role),
      refreshExpiresAt,
    }),
  }
}

async function assertUserFieldAvailability({
  email,
  phone,
  excludeUserId,
}: {
  email: string
  phone: string | null
  excludeUserId?: string
}): Promise<void> {
  const existingUserWithEmail = await prisma.user.findUnique({
    where: {
      email,
    },
  })

  if (existingUserWithEmail && existingUserWithEmail.id !== excludeUserId) {
    throw createHttpError(409, 'An account with this email already exists')
  }

  if (!phone) {
    return
  }

  const existingUserWithPhone = await prisma.user.findUnique({
    where: {
      phone,
    },
  })

  if (existingUserWithPhone && existingUserWithPhone.id !== excludeUserId) {
    throw createHttpError(409, 'An account with this phone number already exists')
  }
}

async function assertShopOwnerFieldAvailability({
  gstNumber,
  excludeProfileId,
}: {
  gstNumber: string | null
  excludeProfileId?: string
}): Promise<void> {
  if (!gstNumber) {
    return
  }

  const existingProfile = await prisma.shopOwnerProfile.findUnique({
    where: {
      gstNumber,
    },
  })

  if (existingProfile && existingProfile.id !== excludeProfileId) {
    throw createHttpError(409, 'This GST number is already linked to another account')
  }
}

async function createRefreshSession(user: Pick<AuthUser, 'id'>) {
  const refreshToken = createRefreshTokenValue()
  const tokenHash = hashToken(refreshToken)
  const expiresAt = new Date(
    Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  )

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt,
    },
  })

  return {
    refreshToken,
    expiresAt: expiresAt.toISOString(),
  }
}

async function createAuthenticatedSession(userId: string) {
  const user = await getUserForAuth(userId)

  if (!user || !user.isActive) {
    throw createHttpError(401, 'Your account is not available for login')
  }

  const accessToken = signAccessToken(user)
  const refreshSession = await createRefreshSession(user)

  return {
    ...buildSessionResponse(user, accessToken, refreshSession.expiresAt),
    refreshToken: refreshSession.refreshToken,
  }
}

async function registerCustomer(payload: RegisterCustomerInput) {
  const email = normalizeEmail(payload.email)
  const phone = normalizeOptionalString(payload.phone)

  await assertUserFieldAvailability({ email, phone })

  const passwordHash = await hashPassword(payload.password)

  const user = await prisma.user.create({
    data: {
      fullName: payload.fullName.trim(),
      email,
      phone,
      passwordHash,
      role: 'CUSTOMER',
      customerProfile: {
        create: {},
      },
    },
  })

  return createAuthenticatedSession(user.id)
}

async function registerShopOwner(payload: RegisterShopOwnerInput) {
  const email = normalizeEmail(payload.email)
  const phone = normalizeOptionalString(payload.phone)
  const gstNumber = normalizeOptionalString(payload.gstNumber)

  await assertUserFieldAvailability({ email, phone })
  await assertShopOwnerFieldAvailability({ gstNumber })

  const passwordHash = await hashPassword(payload.password)

  const user = await prisma.user.create({
    data: {
      fullName: payload.fullName.trim(),
      email,
      phone,
      passwordHash,
      role: 'SHOP_OWNER',
      shopOwnerProfile: {
        create: {
          businessName: payload.businessName.trim(),
          gstNumber,
          isApproved: false,
        },
      },
    },
  })

  return createAuthenticatedSession(user.id)
}

async function login(payload: LoginInput) {
  const email = normalizeEmail(payload.email)
  const user = await prisma.user.findUnique({
    where: {
      email,
    },
  })

  if (!user) {
    throw createHttpError(401, 'Invalid email or password')
  }

  if (!user.isActive) {
    throw createHttpError(403, 'Your account is inactive. Contact support to continue')
  }

  const isPasswordValid = await verifyPassword(payload.password, user.passwordHash)

  if (!isPasswordValid) {
    throw createHttpError(401, 'Invalid email or password')
  }

  return createAuthenticatedSession(user.id)
}

async function logout(refreshTokenValue: string | null): Promise<void> {
  if (!refreshTokenValue) {
    return
  }

  await prisma.refreshToken.updateMany({
    where: {
      tokenHash: hashToken(refreshTokenValue),
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  })
}

async function getAuthenticatedUser(userId: string) {
  const user = await getUserForAuth(userId)

  if (!user) {
    throw createHttpError(404, 'User not found')
  }

  return {
    user: mapSafeUser(user),
    meta: buildMeta({
      role: user.role,
      dashboardPath: getDashboardPathForRole(user.role),
    }),
  }
}

async function refreshSession(refreshTokenValue: string | null) {
  if (!refreshTokenValue) {
    throw createHttpError(401, 'Refresh session not found')
  }

  const tokenHash = hashToken(refreshTokenValue)
  const refreshTokenRecord = await prisma.refreshToken.findUnique({
    where: {
      tokenHash,
    },
    include: {
      user: {
        include: authUserInclude,
      },
    },
  })

  if (!refreshTokenRecord) {
    throw createHttpError(401, 'Refresh session is invalid')
  }

  if (refreshTokenRecord.revokedAt) {
    // Reuse of a refresh token that was already rotated away is the standard signal of token
    // theft under rotation: the legitimate client already exchanged this exact token for a
    // newer one, so whoever just presented it again is not that client (stolen cookie/body
    // token, replayed request, etc). Rather than just rejecting this one call, revoke every
    // other still-active session for the user too — otherwise an attacker holding a stolen
    // (but not-yet-rotated-by-them) token could keep the legitimate session's sibling tokens
    // alive indefinitely while this branch quietly no-ops.
    await prisma.refreshToken.updateMany({
      where: { userId: refreshTokenRecord.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    throw createHttpError(401, 'Refresh session is invalid')
  }

  if (refreshTokenRecord.expiresAt <= new Date()) {
    throw createHttpError(401, 'Refresh session has expired')
  }

  if (!refreshTokenRecord.user.isActive) {
    throw createHttpError(403, 'Your account is inactive. Contact support to continue')
  }

  const nextRefreshToken = createRefreshTokenValue()
  const nextRefreshTokenHash = hashToken(nextRefreshToken)
  const nextExpiresAt = new Date(
    Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  )

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: {
        id: refreshTokenRecord.id,
      },
      data: {
        revokedAt: new Date(),
      },
    }),
    prisma.refreshToken.create({
      data: {
        userId: refreshTokenRecord.userId,
        tokenHash: nextRefreshTokenHash,
        expiresAt: nextExpiresAt,
      },
    }),
  ])

  return {
    ...buildSessionResponse(
      refreshTokenRecord.user,
      signAccessToken(refreshTokenRecord.user),
      nextExpiresAt.toISOString(),
    ),
    refreshToken: nextRefreshToken,
  }
}

export {
  buildRefreshCookieOptions,
  getAuthenticatedUser,
  getRefreshTokenFromRequest,
  login,
  logout,
  refreshSession,
  registerCustomer,
  registerShopOwner,
}
