/**
 * Prints a session cookie for a demo user, for poking at the running app with
 * curl without going through the login form.
 *
 *   npx tsx scripts/dev-session.ts sunita
 *
 * Development only — it mints a token directly from AUTH_SECRET.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { SignJWT } from 'jose';
import { loadRootEnv } from '../load-env.mjs';
import {
  createPostgresClient,
  organisations,
  users,
  type Database,
} from '../packages/db/src/index';

loadRootEnv();

const username = process.argv[2] ?? 'sunita';
const orgSlug = process.argv[3] ?? 'shiksha-demo';

async function main(): Promise<void> {
  const client = createPostgresClient(process.env.DATABASE_URL!, 1);
  const db = drizzle(client) as unknown as Database;

  try {
  const [row] = await db
    .select({ user: users, orgSlug: organisations.slug, orgId: organisations.id })
    .from(users)
    .innerJoin(organisations, eq(organisations.id, users.orgId))
    .where(and(eq(organisations.slug, orgSlug), eq(users.username, username)))
    .limit(1);

  if (!row) throw new Error(`No user "${username}" in organisation "${orgSlug}"`);

  const token = await new SignJWT({
    orgId: row.orgId,
    userId: row.user.id,
    role: row.user.role,
    username: row.user.username,
    fullName: row.user.fullName,
    locale: row.user.locale ?? 'en',
    orgSlug: row.orgSlug,
    mustChangePin: row.user.mustChangePin,
    tokenVersion: row.user.tokenVersion,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));

  process.stdout.write(`mis_session=${token}\n`);
} finally {
  await client.end();
}
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
