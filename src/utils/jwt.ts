import jwt, { type SignOptions } from 'jsonwebtoken'

import env from '../config/env'
import type { AccessTokenPayload, AuthUser } from '../types/auth'

function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    {
      role: user.role,
      email: user.email,
    },
    env.jwtAccessSecret,
    {
      expiresIn: env.jwtAccessExpiresIn as SignOptions['expiresIn'],
      subject: user.id,
    },
  )
}

function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.jwtAccessSecret)

  if (typeof payload === 'string' || !payload.sub || !payload.role) {
    throw new Error('Invalid access token payload')
  }

  return {
    sub: payload.sub,
    role: payload.role as AccessTokenPayload['role'],
    email: typeof payload.email === 'string' ? payload.email : '',
    iat: payload.iat,
    exp: payload.exp,
  }
}

export { signAccessToken, verifyAccessToken }
