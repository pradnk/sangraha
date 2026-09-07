/**
 * Applies migrations as part of a deployment.
 *
 *   npm run db:deploy
 *
 * Exists because the production target is Vercel, where there is no shell to
 * run `npm run db:migrate` in. It runs during the build instead, so an NGO can
 * deploy from the Vercel dashboard and end up with a working database without
 * ever opening a terminal.
 *
 * Three differences from `db:migrate`, all of them about running unattended:
 *
 *   - It takes a Postgres advisory lock, so two deployments finishing at the
 *     same time cannot apply migrations concurrently. The second waits, sees
 *     the work already done, and exits.
 *   - It is skippable (`SKIP_MIGRATIONS=1`) for teams that would rather gate
 *     schema changes behind their own process.
 *   - With no DATABASE_URL it warns and exits zero rather than failing the
 *     build. A preview deployment without a database attached should still
 *     build; it simply will not run.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { unpooledConnection } from '../packages/db/src/client';
import { loadRootEnv } from '../load-env.mjs';

loadRootEnv();

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * An arbitrary but fixed key. Any process using this same number is
 * co-ordinating on the same thing; nothing else in the system takes advisory
 * locks, so a collision would have to be deliberate.
 */
const MIGRATION_LOCK_KEY = 8_246_113;

/** Long enough for a slow migration, short enough not to hang a build. */
const LOCK_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS === '1') {
    console.log('→ SKIP_MIGRATIONS=1, leaving the database alone');
    return;
  }

  if (!process.env.DATABASE_URL) {
    // Not an error: a preview build with no database attached should still
    // produce a bundle. It will fail loudly at runtime instead, which is the
    // right place for that to surface.
    console.warn('⚠ DATABASE_URL is not set — skipping migrations.');
    console.warn('  The app will not start until it is configured.');
    return;
  }

  /*
   * The lock is session-scoped, so this connection must not be a transaction
   * pooler's. `pg_try_advisory_lock` holds until the session ends or the lock
   * is released — but a transaction pooler hands the next statement to a
   * different backend, so the lock would be taken on one, the migration would
   * run unprotected, and the unlock would return false against a third. Two
   * concurrent deployments would then both migrate, which is the single thing
   * this script exists to prevent, and nothing would report an error.
   *
   * `unpooledConnection` gives session mode on Supabase and the direct
   * endpoint on Neon; `DATABASE_DIRECT_URL` overrides both. Where there is no
   * pooler there is nothing to avoid and this is the same string.
   */
  const ownerUrl = process.env.DATABASE_URL;
  const lockUrl = unpooledConnection(ownerUrl) ?? ownerUrl;
  const client = postgres(lockUrl, { max: 1, prepare: false, onnotice: () => {} });

  try {
    console.log('→ waiting for the migration lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let held = false;

    while (Date.now() < deadline) {
      // The non-blocking variant, polled, rather than pg_advisory_lock: a build
      // that hangs forever on a lock is worse than one that fails with a
      // message someone can act on.
      const [row] = await client<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) AS locked
      `;
      if (row?.locked) {
        held = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!held) {
      throw new Error(
        'Another deployment has held the migration lock for two minutes. ' +
          'If no deployment is running, a previous one may have died mid-migration — ' +
          'check the database before retrying.',
      );
    }

    try {
      console.log('→ applying migrations');
      // Reuses the ordinary migrate script rather than duplicating its logic,
      // so there is one definition of what "migrated" means.
      const result = spawnSync('npm', ['run', 'db:migrate'], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      });
      if (result.status !== 0) throw new Error('Migrations failed. The deployment should not proceed.');
      console.log('✓ database is ready');
    } finally {
      await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
