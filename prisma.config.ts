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
  // NOTE (found while adding the FavoriteShop table / Order driver columns): `prisma db push`
  // against the real `libsql://` Turso URL fails either way on Prisma 7 — "datasource.url is
  // required" without a `datasource.url` key here, or "P1013 scheme not recognized" with one
  // (the CLI's own URL validation doesn't understand `libsql://`, even though the adapter below
  // handles the real connection for the running app fine). Schema changes were applied directly
  // against Turso via `@libsql/client` raw DDL instead (mirrors how the prior schema-drift bug
  // was reconciled) — see prisma/schema.prisma's git history for the Prisma-schema source of
  // truth; this file's `db push`/`migrate` commands remain useful against the local `file:`
  // fallback DB only until this CLI limitation is worked around for real.
  adapter: async () =>
    new PrismaLibSql({
      url: process.env.DATABASE_URL || 'file:./prisma/nearkart.db',
      ...(process.env.DATABASE_AUTH_TOKEN
        ? { authToken: process.env.DATABASE_AUTH_TOKEN }
        : {}),
    }),
})
