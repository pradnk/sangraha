/**
 * Applies the schema, then the declarative SQL layer.
 *
 * Two stages, because they have different shapes:
 *
 *   migrations/  Drizzle-generated, incremental, run once each. Tables, columns,
 *                indexes — things with history.
 *   sql/         Hand-written, idempotent, re-applied every time. Policies,
 *                grants and helper functions are easier to review and reason
 *                about as whole files than as a chain of diffs, and re-applying
 *                them means a policy can never silently drift.
 *
 * With one exception, `000-extensions.sql`, which the schema depends on and so
 * has to run before it. See PRE_MIGRATION_SQL.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadRootEnv } from '../../../load-env.mjs';
import { appRoleName } from './app-role';
import { unpooledConnection } from './client';

// Configuration lives in one .env at the repo root, shared with the app and the
// tests. Loaded here rather than via a `--env-file` flag so the script works
// from any directory and `npm run db:migrate` behaves the same as running it by
// hand. Real environment variables always win, so Docker and CI are unaffected.
loadRootEnv();

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/**
 * The one file in `sql/` applied before the schema migrations instead of after.
 *
 * `0000_initial_schema.sql` declares an `ltree` column and a trigram index, so
 * the extensions have to be in place before Drizzle runs or the very first
 * statement fails. Numbered 000 to say so; everything from 010 up depends on
 * the schema existing and therefore runs at the end.
 */
const PRE_MIGRATION_SQL = '000-extensions.sql';

async function main(): Promise<void> {
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error(missingEnvMessage('DATABASE_URL'));

  const appCredentials = parseAppCredentials(process.env.DATABASE_APP_URL);

  const client = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  const sqlDir = join(packageRoot, 'sql');

  try {
    // Before the migrations, not after: the schema is declared in terms of
    // types these provide.
    await applySqlFile(client, sqlDir, PRE_MIGRATION_SQL, appCredentials.username);

    console.log('→ applying schema migrations');
    await migrate(db, { migrationsFolder: join(packageRoot, 'migrations') });

    console.log(`→ ensuring application role "${appCredentials.username}"`);
    await ensureAppRole(client, ownerUrl, appCredentials);

    const files = (await readdir(sqlDir))
      .filter((f) => f.endsWith('.sql') && f !== PRE_MIGRATION_SQL)
      .sort();
    for (const file of files) {
      await applySqlFile(client, sqlDir, file, appCredentials.username);
    }

    console.log('✓ database is up to date');
  } finally {
    await client.end();
  }
}

/**
 * Applies one file from `sql/`.
 *
 * The `@APP_ROLE@` substitution is the reason this is not just a read and an
 * execute: a role name cannot be a bind parameter in DDL, and `030-grants.sql`
 * has to name one. Substituted here so there is a single source for it — the
 * file used to say `mis_app` literally, which meant any deployment whose
 * DATABASE_APP_URL named a different user migrated successfully and then failed
 * every request on a permission error.
 */
async function applySqlFile(
  client: postgres.Sql,
  sqlDir: string,
  file: string,
  appRole: string,
): Promise<void> {
  console.log(`→ applying ${file}`);
  const contents = await readFile(join(sqlDir, file), 'utf8');
  await client.unsafe(contents.replaceAll('@APP_ROLE@', quoteIdentifier(appRole)));
}

interface AppCredentials {
  username: string;
  password: string;
}

/**
 * The message names the fix rather than the variable — and which fix it is
 * depends on where this is running.
 *
 * On a fresh clone it is a missing `.env`. In a deployment build there is no
 * file to create and no shell to create it in, so `cp .env.example .env` was
 * not merely unhelpful but misleading, in the place it was most often read: the
 * build log of a first deploy.
 *
 * DATABASE_APP_URL gets an extra paragraph because it is the one variable
 * nobody expects. Every managed provider hands out a single connection string,
 * so the natural response to this error is to reuse it — and that quietly
 * removes the tenant boundary rather than failing. The answer belongs here,
 * where the question actually gets asked.
 */
function missingEnvMessage(variable: string): string {
  // Vercel sets VERCEL; other CI sets CI. Either way there is no .env to fix.
  const deployed = Boolean(process.env.VERCEL || process.env.CI);

  const lines = [`${variable} is not set.`, ''];

  if (deployed) {
    lines.push(
      "Set it in your deployment platform's environment variables, then deploy",
      'again — a build reads them once, so redeploying an existing build will',
      'not pick it up. Check it is set for this environment in particular: a',
      'variable added only to production is absent from a preview build.',
    );
  } else {
    lines.push(
      'If this is a fresh clone:',
      '  cp .env.example .env',
      '',
      `Otherwise check that .env at the repo root defines ${variable}.`,
    );
  }

  if (variable === 'DATABASE_APP_URL') {
    lines.push(
      '',
      'This is a second connection string for the same database, differing only',
      'in the role. That role need not exist yet — this script creates it from',
      'the username and password in the URL you supply:',
      '',
      `  postgresql://${appRoleName()}:<a-password-you-choose>@<same-host>/<same-database>`,
      '',
      'It cannot be DATABASE_URL. That role owns the tables, and an owner',
      'bypasses its own row-level security, which is the entire tenant',
      'boundary. Serving requests on it would isolate nothing, and would not',
      'fail while it did so.',
    );
  }

  return lines.join('\n');
}

function parseAppCredentials(url: string | undefined): AppCredentials {
  if (!url) throw new Error(missingEnvMessage('DATABASE_APP_URL'));
  const parsed = new URL(url);
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!username || !password) {
    throw new Error('DATABASE_APP_URL must include a username and password');
  }
  return { username, password };
}

/** The four role attributes that decide whether RLS applies to it at all. */
interface RoleAttributes {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
}

/** A statement run against whichever connection will accept it. */
type RoleDdl = (what: string, statement: (sql: postgres.Sql) => Promise<unknown>) => Promise<void>;

/**
 * Creates or updates the non-owner role the application connects as.
 *
 * Done here rather than in a .sql file so the credentials come from the
 * environment and never sit in version control.
 */
async function ensureAppRole(
  client: postgres.Sql,
  ownerUrl: string,
  { username, password }: AppCredentials,
): Promise<void> {
  const existing = await roleAttributes(client, username);

  /*
   * Role DDL, retried without the pooler if this connection refuses it. A
   * managed provider may handle `CREATE ROLE` outside Postgres — see
   * `unpooledConnection` — and refuse it on a pooled connection that takes
   * every other kind of DDL happily. The pooled connection is still tried
   * first, so the ordinary case opens nothing extra.
   */
  const roleDdl: RoleDdl = async (what, statement) => {
    try {
      await statement(client);
      return;
    } catch (error) {
      const direct = unpooledConnection(ownerUrl);
      if (!direct) throw error;

      console.warn(`⚠ ${what} was refused on this connection; retrying without the pooler`);
      const directClient = postgres(direct, { max: 1, onnotice: () => {} });
      try {
        await statement(directClient);
      } finally {
        await directClient.end();
      }
    }
  };

  // Role names cannot be parameterised in DDL, so the identifier is quoted by
  // the driver rather than interpolated raw.
  const ident = (sql: postgres.Sql) => sql(username);
  const secret = quoteLiteral(password);

  if (!existing) {
    /*
     * CREATE ROLE leaves all four attributes below off, which is exactly what
     * is wanted. They are verified afterwards rather than restated here —
     * see assertRlsApplies for why restating them broke deployments.
     */
    try {
      await roleDdl(
        `creating the role "${username}"`,
        (sql) => sql`CREATE ROLE ${ident(sql)} LOGIN PASSWORD ${sql.unsafe(secret)}`,
      );
    } catch (error) {
      throw new Error(
        [
          `Could not create the role "${username}".`,
          '',
          'A managed provider may not allow this over SQL at all — Neon forwards',
          'role changes to its own control plane, and a refusal there surfaces as',
          'an error naming neither the role nor the reason:',
          '',
          '  XX000  ddl_forwarding.c  SendDeltasToControlPlane',
          '',
          `Create the role by hand instead, with the password already in`,
          'DATABASE_APP_URL, and deploy again — on Neon that is Branches → Roles.',
          'Give it no attributes at all: no SUPERUSER, no BYPASSRLS, no CREATEDB,',
          'no CREATEROLE. This script grants it everything it needs and will not',
          'try to create it again.',
          '',
          describeError(error),
        ].join('\n'),
      );
    }
  } else {
    try {
      await roleDdl(
        `setting the password for "${username}"`,
        (sql) => sql`ALTER ROLE ${ident(sql)} LOGIN PASSWORD ${sql.unsafe(secret)}`,
      );
    } catch (error) {
      /*
       * The role is already there and only its password could not be
       * synchronised, which is the better of the two failures to have: a
       * password that does not match is visible at the first request and in
       * /api/health, where no deployment at all breaks everything.
       */
      console.warn(`⚠ could not set the password for "${username}": ${describeError(error)}`);
      console.warn('  Continuing. Requests will only be served if it already matches');
      console.warn('  the password in DATABASE_APP_URL.');
    }
  }

  await assertRlsApplies(client, roleDdl, username);
}

async function roleAttributes(
  client: postgres.Sql,
  username: string,
): Promise<RoleAttributes | null> {
  const [row] = await client<RoleAttributes[]>`
    SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    FROM pg_roles
    WHERE rolname = ${username}
  `;
  return row ?? null;
}

/**
 * Refuses to migrate if the role that serves requests could ignore RLS.
 *
 * Verified rather than asserted, and that distinction is the whole of a real
 * failure. `ALTER ROLE ... NOSUPERUSER NOBYPASSRLS` may only be issued by a
 * superuser, and on a managed provider nobody is one — so the statement whose
 * entire purpose was to guarantee the tenant boundary was itself what stopped
 * the deployment, on a role that already held none of these. A freshly created
 * role has all four off, so the ordinary path now issues no DDL at all.
 *
 * SUPERUSER and BYPASSRLS are fatal: the policies in 020-rls.sql are the whole
 * of the tenant boundary, and a role holding either reads every organisation's
 * records with nothing appearing wrong. CREATEDB and CREATEROLE are untidy
 * rather than dangerous, and only warn.
 */
async function assertRlsApplies(
  client: postgres.Sql,
  roleDdl: RoleDdl,
  username: string,
): Promise<void> {
  const attributes = await roleAttributes(client, username);
  if (!attributes) throw new Error(`Role "${username}" is absent after being created.`);

  const held = (
    [
      ['SUPERUSER', attributes.rolsuper, true],
      ['BYPASSRLS', attributes.rolbypassrls, true],
      ['CREATEDB', attributes.rolcreatedb, false],
      ['CREATEROLE', attributes.rolcreaterole, false],
    ] as const
  ).filter(([, on]) => on);

  if (held.length === 0) return;

  const names = held.map(([name]) => name).join(', ');

  try {
    await roleDdl(
      `revoking ${names} from "${username}"`,
      (sql) => sql`ALTER ROLE ${sql(username)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    return;
  } catch (error) {
    if (!held.some(([, , fatal]) => fatal)) {
      console.warn(`⚠ "${username}" holds ${names}, which could not be revoked.`);
      console.warn('  Untidy but harmless — RLS still applies to it.');
      return;
    }

    throw new Error(
      [
        `Role "${username}" holds ${names}, and it could not be revoked.`,
        '',
        'Refusing to migrate. That role serves every request, and SUPERUSER or',
        'BYPASSRLS on it makes every policy in 020-rls.sql decorative: one',
        "organisation would read another's people, submissions and consent",
        'records, and nothing would look wrong.',
        '',
        'Revoke it, then deploy again:',
        `  ALTER ROLE ${username} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`,
        '',
        'On a managed provider that may need the console rather than SQL. Or',
        `point DATABASE_APP_URL at a plain role — one created with no attributes`,
        'at all is exactly right.',
        '',
        describeError(error),
      ].join('\n'),
    );
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
