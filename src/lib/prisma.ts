import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as typeof globalThis & {
  __nearkartPrisma?: PrismaClient
}
const databaseUrl = process.env.DATABASE_URL || 'file:./prisma/nearkart.db'

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaLibSql({ url: databaseUrl })

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

const prisma =
  globalForPrisma.__nearkartPrisma ||
  createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__nearkartPrisma = prisma
}

export default prisma
