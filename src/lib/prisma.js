const { PrismaClient } = require('@prisma/client')
const { PrismaLibSql } = require('@prisma/adapter-libsql')

const globalForPrisma = globalThis
const databaseUrl = process.env.DATABASE_URL || 'file:./prisma/nearcart.db'

function createPrismaClient() {
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

module.exports = prisma
