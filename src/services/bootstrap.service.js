const prisma = require('../lib/prisma')
const env = require('../config/env')
const { hashPassword } = require('../utils/password')
const { normalizeEmail } = require('../utils/user')

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
        `[NearCart] Admin bootstrap skipped because ${email} already exists as ${existingUser.role}.`,
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

  console.log(`[NearCart] Bootstrapped admin account for ${email}.`)

  return adminUser
}

module.exports = {
  ensureBootstrapAdmin,
}
