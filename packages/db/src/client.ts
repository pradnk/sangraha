import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Database = ReturnType<typeof createDatabase>;

/**
 * Accepts either a pooled connection or a transaction.
 *
 * Query helpers take this so the same function works standalone and inside
 * `withContext`, which is the only way it gets an RLS context.
 */
export type DbLike = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

/** The transaction handle passed to `withContext`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Identity a request acts under. Drives every Row-Level Security policy. */
export interface RequestContext {
  orgId: string;
  userId: string;
  role: 'field_worker' | 'supervisor' | 'org_admin' | 'super_admin';
}

/**
 * Postgres OID 20 — `int8` / `bigint`.
 *
 * postgres.js returns int8 as a *string* by default, to avoid silently losing
 * precision above 2^53. That default is wrong for this application: `integer`
 * form answers are stored in bigint columns, and a string would surface in the
 * REST API as `"age": "12"` — exactly the kind of wart that makes an API
 * annoying to consume.
 *
 * Parsing to Number is safe here because the form engine validates these values
 * as JavaScript integers on the way in, so a value that could not survive the
 * round trip could never have been stored.
 */
const INT8_OID = 20;

/**
 * How this process should talk to Postgres.
 *
 * The same code runs in two very different places, and the right settings are
 * opposite in each:
 *
 *   **A long-lived server** (local development, a container) wants a real pool.
 *   One process handles every request, so ten connections held open is exactly
 *   what you want.
 *
 *   **A serverless function** (Vercel) wants almost none. Every concurrent
 *   invocation is its own process with its own pool, so `max: 10` across thirty
 *   warm instances is three hundred connections against a database that permits
 *   a hundred. The fix is one connection each, and a pooler in front.
 *
 * Detected rather than configured, because getting it wrong produces
 * "too many connections" under load and nothing at all in testing.
 */
export interface ConnectionProfile {
  max: number;
  prepare: boolean;
  idleTimeout: number;
  connectTimeout: number;
}

/** True on Vercel, and on anything else that sets the convention. */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Whether the connection string points at a transaction pooler.
 *
 * This matters for one specific reason: PgBouncer in transaction mode hands a
 * different backend to each statement, so a prepared statement created on one
 * is not there on the next. postgres.js prepares by default, which fails with
 * "prepared statement does not exist" — intermittently, under load, which is
 * the worst way to find out.
 *
 * Recognises the shapes the common providers use. `DATABASE_POOLED` overrides
 * it for anything unusual.
 */
export function looksPooled(connectionString: string): boolean {
  const override = process.env.DATABASE_POOLED?.trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;

  return (
    connectionString.includes('-pooler.') || // Neon
    connectionString.includes(':6543') || // Supabase transaction pooler
    connectionString.includes('pgbouncer=true')
  );
}

export function connectionProfile(connectionString: string): ConnectionProfile {
  const serverless = isServerless();
  const pooled = looksPooled(connectionString);

  const configuredMax = Number(process.env.DATABASE_POOL_MAX);
  /*
   * Three sizes, because the three situations are genuinely different.
   *
   *   serverless   one per instance; the platform scales by adding instances,
   *                not by giving each one a pool.
   *   production   ten, sized for concurrent requests on one long-lived server.
   *   development  four, sized for one person clicking.
   *
   * The development number is not a micro-optimisation. Every Next process opens
   * *two* of these — the app role and the owner role — so ten each meant twenty
   * connections per dev server against Postgres's default hundred. Two dev
   * servers, a test run and a couple of scripts exhausted it, and what you see
   * then is "remaining connection slots are reserved for roles with the
   * SUPERUSER attribute" or a bare 500, neither of which points at the cause.
   * Four keeps a realistic local setup an order of magnitude clear of the limit.
   *
   * `DATABASE_POOL_MAX` overrides all of it.
   */
  const max = Number.isFinite(configuredMax) && configuredMax > 0
    ? configuredMax
    : serverless
      ? 1
      : process.env.NODE_ENV === 'production'
        ? 10
        : 4;

  return {
    max,
    // Safe to keep locally, where there is no pooler in the way.
    prepare: !pooled,
    // Release quickly on serverless so a scaled-down instance is not still
    // holding a slot; hold longer locally, where reconnecting is pure cost.
    idleTimeout: serverless ? 20 : 0,
    connectTimeout: 10,
  };
}

export function createPostgresClient(
  connectionString: string,
  maxOverride?: number,
): postgres.Sql {
  const profile = connectionProfile(connectionString);

  return postgres(connectionString, {
    max: maxOverride ?? profile.max,
    prepare: profile.prepare,
    idle_timeout: profile.idleTimeout || undefined,
    connect_timeout: profile.connectTimeout,
    onnotice: () => {},
    types: {
      int8AsNumber: {
        to: INT8_OID,
        from: [INT8_OID],
        serialize: (value: number | bigint) => value.toString(),
        parse: (value: string) => Number(value),
      },
    },
  });
}

function createDatabase(connectionString: string, maxOverride?: number) {
  return drizzle(createPostgresClient(connectionString, maxOverride), { schema });
}

let appDb: Database | undefined;
let ownerDb: Database | undefined;

/**
 * The request-serving connection.
 *
 * Connects as `mis_app`, which is neither superuser nor table owner, so RLS
 * actually applies. Everything that serves a user request goes through here.
 */
export function getDb(): Database {
  if (!appDb) {
    const url = process.env.DATABASE_APP_URL;
    if (!url) throw new Error('DATABASE_APP_URL is not set');
    appDb = createDatabase(url);
  }
  return appDb;
}

/**
 * The privileged connection.
 *
 * Owns the schema and therefore bypasses RLS. Reserved for migrations, seeding
 * and analytics view generation — never for serving a request. Keeping these
 * apart is what stops a missing tenant filter from becoming a data leak.
 */
export function getOwnerDb(): Database {
  if (!ownerDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    // Same profile as the app connection. Both pools exist in every instance,
    // so on serverless that is two connections per instance, not fifteen.
    ownerDb = createDatabase(url);
  }
  return ownerDb;
}

/**
 * Runs `work` inside a transaction carrying the caller's RLS context.
 *
 * `SET LOCAL` scopes the settings to this transaction, so a pooled connection
 * cannot leak one tenant's context into the next request — the single most
 * important detail in this file.
 *
 * Every query that serves a request should go through here. A query issued
 * outside it sees nothing, because `app.current_org_id()` returns NULL and no
 * policy matches.
 */
export async function withContext<T>(
  context: RequestContext,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => {
    // set_config's third argument (`true`) makes it transaction-local.
    // Parameterised rather than interpolated, so a crafted org id cannot
    // become SQL.
    await tx.execute(sql`select set_config('app.org_id', ${context.orgId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
    await tx.execute(sql`select set_config('app.role', ${context.role}, true)`);
    return work(tx);
  });
}

export { schema };
