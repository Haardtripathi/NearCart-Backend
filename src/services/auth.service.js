const env = require('../config/env')
const prisma = require('../lib/prisma')
const { mapSafeUser } = require('../utils/serializers')
const { hashPassword, verifyPassword } = require('../utils/password')
const { buildMeta } = require('../utils/response')
const { createHttpError } = require('../utils/httpError')
const { signAccessToken } = require('../utils/jwt')
const { parseCookies } = require('../utils/cookies')
const { createRefreshTokenValue, hashToken } = require('../utils/token')
const {
  getDashboardPathForRole,
  normalizeEmail,
  normalizeOptionalString,
} = require('../utils/user')

const authUserInclude = {
  customerProfile: {
    include: {
      defaultAddress: true,
    },
  },
  shopOwnerProfile: true,
}

function buildRefreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: env.nodeEnv === 'production' ? 'none' : 'lax',
    secure: env.nodeEnv === 'production',
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  }
}

function getRefreshTokenFromRequest(request) {
  const cookies = parseCookies(request.headers.cookie)

  return cookies[env.authRefreshCookieName] || null
}

async function getUserForAuth(userId) {
  return prisma.user.findUnique({
    where: {
      id: userId,
    },
    include: authUserInclude,
  })
}

function buildSessionResponse(user, accessToken, refreshExpiresAt) {
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

async function assertUserFieldAvailability({ email, phone, excludeUserId }) {
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

async function assertShopOwnerFieldAvailability({ gstNumber, excludeProfileId }) {
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

async function createRefreshSession(user) {
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

async function createAuthenticatedSession(userId) {
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

async function registerCustomer(payload) {
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

async function registerShopOwner(payload) {
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

async function login(payload) {
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

async function logout(refreshTokenValue) {
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

async function getAuthenticatedUser(userId) {
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

async function refreshSession(refreshTokenValue) {
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

  if (!refreshTokenRecord || refreshTokenRecord.revokedAt) {
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

module.exports = {
  buildRefreshCookieOptions,
  getAuthenticatedUser,
  getRefreshTokenFromRequest,
  login,
  logout,
  refreshSession,
  registerCustomer,
  registerShopOwner,
}
