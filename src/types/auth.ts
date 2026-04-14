import type { Request } from 'express'
import type { Prisma, UserRole } from '@prisma/client'

export const authUserInclude = {
  customerProfile: {
    include: {
      defaultAddress: true,
    },
  },
  shopOwnerProfile: true,
} satisfies Prisma.UserInclude

export type AuthUser = Prisma.UserGetPayload<{
  include: typeof authUserInclude
}>

export interface RequestAuth {
  userId: string
  role: UserRole
  user: AuthUser
}

export type AuthenticatedRequest = Request & {
  auth: RequestAuth
}

export interface AccessTokenPayload {
  sub: string
  role: UserRole
  email: string
  iat?: number
  exp?: number
}
