import prisma from '../lib/prisma'
import env from '../config/env'
import { hashPassword } from '../utils/password'
import { normalizeEmail } from '../utils/user'

async function ensureBootstrapAdmin() {
  if (!env.adminBootstrapEmail || !env.adminBootstrapPassword) {
    return null
  }

  const email = normalizeEmail(env.adminBootstrapEmail)
  const existingUser = await prisma.user.findUnique({
    where: {
      email,
    },
  })

  if (existingUser) {
    if (existingUser.role !== 'ADMIN') {
      console.warn(
        `[NearKart] Admin bootstrap skipped because ${email} already exists as ${existingUser.role}.`,
      )
    }

    return existingUser
  }

  const passwordHash = await hashPassword(env.adminBootstrapPassword)

  const adminUser = await prisma.user.create({
    data: {
      fullName: env.adminBootstrapFullName,
      email,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
      isVerified: true,
    },
  })

  console.log(`[NearKart] Bootstrapped admin account for ${email}.`)

  return adminUser
}

export { ensureBootstrapAdmin }
