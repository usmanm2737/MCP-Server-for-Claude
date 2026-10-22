import { defineConfig } from 'vitest/config';

// Running `vitest`/`npx vitest` directly (as opposed to through this project's
// npm scripts, which pass --env-file-if-exists=.env to node) never loads .env
// on its own — load it here so TEST_DATABASE_URL etc. are set regardless of
// how the test run was invoked.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file — fine, env vars may already be set another way
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Tests share one real Postgres database (truncating tables between tests,
    // not an isolated in-memory instance per test) — running files concurrently
    // would let two files' TRUNCATEs/queries race against each other.
    fileParallelism: false,
    // Real network round-trips to Postgres now (not an in-memory database), and
    // some tests chain several sequential writes (e.g. saving multiple
    // activities in a loop) — each one a real round trip. 15s was tuned for
    // the old instant in-memory SQLite client and is too tight for that.
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
