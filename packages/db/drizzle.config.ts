import { defineConfig } from 'drizzle-kit';
import { loadRootEnv } from '../../load-env.mjs';

loadRootEnv();

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://mis:mis_dev_password@localhost:5432/mis',
  },
  // Hand-written SQL migrations sit alongside the generated ones (RLS policies,
  // the analytics helper functions), so verbose output makes ordering issues
  // obvious during review.
  verbose: true,
  strict: true,
});
