import { sql } from 'drizzle-orm';
import { appRoleName, getOwnerDb, looksPooled } from '@sangraha/db';

/**
 * Is this deployment actually working?
 *
 * Exists for the person who has just deployed to Vercel and has no shell to
 * check from. "The page loads" says nothing about whether the database is
 * reachable, migrated, or the right one — and those are exactly the things that
 * go wrong on a first deploy.
 *
 * Deliberately says nothing a stranger could use: no connection strings, no
 * versions, no counts. Reachable or not, migrated or not.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, boolean> = {
    databaseReachable: false,
    schemaPresent: false,
    rlsEnabled: false,
    appRolePresent: false,
  };

  try {
    const db = getOwnerDb();

    await db.execute(sql`SELECT 1`);
    checks.databaseReachable = true;

    // `organisations` is the first table every migration creates, so its
    // absence means migrations have not run.
    const [schema] = (await db.execute(sql`
      SELECT to_regclass('public.organisations') IS NOT NULL AS present
    `)) as unknown as { present: boolean }[];
    checks.schemaPresent = Boolean(schema?.present);

    if (checks.schemaPresent) {
      // Tenant isolation is a property of the database, not the code. A
      // deployment where the policies did not apply would look completely
      // normal until it leaked.
      const [rls] = (await db.execute(sql`
        SELECT count(*)::int AS unprotected
        FROM pg_tables
        WHERE schemaname = 'public' AND NOT rowsecurity
      `)) as unknown as { unprotected: number }[];
      checks.rlsEnabled = Number(rls?.unprotected ?? 1) === 0;

      /*
       * Derived from DATABASE_APP_URL, never named here. A literal `mis_app`
       * meant any deployment that chose another username reported
       * appRolePresent: false — degraded, 503 — on a database that was entirely
       * healthy, which is the worst kind of health check: one that cries wolf
       * and teaches you to ignore it.
       */
      const [role] = (await db.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = ${appRoleName()} AND NOT rolbypassrls
        ) AS present
      `)) as unknown as { present: boolean }[];
      checks.appRolePresent = Boolean(role?.present);
    }
  } catch {
    // Swallowed on purpose: a connection error can carry the host and user.
  }

  const healthy = Object.values(checks).every(Boolean);

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checks,
      // Useful when diagnosing "why is it slow" or "why do queries fail under
      // load" — and it reveals nothing beyond how this process is configured.
      pooling: {
        serverless: Boolean(process.env.VERCEL),
        pooledConnection: process.env.DATABASE_APP_URL
          ? looksPooled(process.env.DATABASE_APP_URL)
          : null,
      },
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
