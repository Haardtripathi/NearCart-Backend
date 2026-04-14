import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as typeof globalThis & {
  __nearcartPrisma?: PrismaClient
}
const databaseUrl = process.env.DATABASE_URL || 'file:./prisma/nearcart.db'

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaLibSql({ url: databaseUrl })

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

const prisma =
  globalForPrisma.__nearcartPrisma ||
  createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__nearcartPrisma = prisma
}

export default prisma
