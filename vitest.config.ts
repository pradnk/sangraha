import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests share one Postgres instance and create real schemas
    // and roles; running suites in parallel would have them trip over each
    // other's DDL.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@sangraha/form-engine': new URL('./packages/form-engine/src/index.ts', import.meta.url).pathname,
      '@sangraha/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      // Mirrors the `@/*` path mapping in apps/web/tsconfig.json.
      '@/': new URL('./apps/web/src/', import.meta.url).pathname,
      /*
       * `server-only` is a Next.js build-time guard with no runtime behaviour —
       * importing it outside a bundler simply fails. Stubbed so server modules
       * can be unit-tested; it does not weaken the guard, which Next enforces
       * at build time regardless.
       */
      'server-only': new URL('./vitest.server-only-stub.ts', import.meta.url).pathname,
    },
  },
});
