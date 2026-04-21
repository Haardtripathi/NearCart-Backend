import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@prisma/client'

import env from '../config/env'

const globalForPrisma = globalThis as typeof globalThis & {
  __nearkartPrisma?: PrismaClient
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaLibSql({ url: env.databaseUrl })

  return new PrismaClient({
    adapter,
    log: env.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
  })
}

const prisma =
  globalForPrisma.__nearkartPrisma ||
  createPrismaClient()

if (env.nodeEnv !== 'production') {
  globalForPrisma.__nearkartPrisma = prisma
}

export default prisma
