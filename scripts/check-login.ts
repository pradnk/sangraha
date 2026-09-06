/**
 * Confirms the demo credentials work, using the same call the login form makes.
 *
 *   npx tsx scripts/check-login.ts
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadRootEnv } from '../load-env.mjs';
import { createPostgresClient, login, type Database } from '../packages/db/src/index';

loadRootEnv();

const ORG_SLUG = 'shiksha-demo';
const ATTEMPTS: [string, string][] = [
  ['admin', '284917'],
  ['supervisor', '571390'],
  ['sunita', '639284'],
  ['ramesh', '639284'],
  ['sunita', '000000'],
];

async function main(): Promise<void> {
  const client = createPostgresClient(process.env.DATABASE_URL!, 1);
  const db = drizzle(client) as unknown as Database;

  try {
    for (const [username, pin] of ATTEMPTS) {
      const result = await login(db, { orgSlug: ORG_SLUG, username, pin });
      const label = `${username} / ${pin}`.padEnd(24);
      console.log(
        result.ok
          ? `  ${label} ✓ signs in as ${result.user.role}`
          : `  ${label} ✗ rejected (${result.reason})`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
