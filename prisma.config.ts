import 'dotenv/config'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { defineConfig } from 'prisma/config'

// The Prisma CLI cannot parse a `libsql://` URL from `datasource.url`, so the libSQL driver
// adapter is declared here instead. This is what lets `prisma db push` / `prisma migrate` run
// against the hosted Turso database, mirroring the runtime client in src/lib/prisma.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  adapter: async () =>
    new PrismaLibSql({
      url: process.env.DATABASE_URL || 'file:./prisma/nearkart.db',
      ...(process.env.DATABASE_AUTH_TOKEN
        ? { authToken: process.env.DATABASE_AUTH_TOKEN }
        : {}),
    }),
})
