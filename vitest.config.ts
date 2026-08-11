import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // All test files share one disposable SQLite `file:` test DB (see tests/global-setup.ts) —
    // running test files in parallel worker processes against the same file risks libSQL
    // lock/contention flakiness for no real benefit at this suite's size. Sequential file
    // execution trades a bit of wall-clock time for determinism.
    fileParallelism: false,
  },
})
