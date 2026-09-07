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
    await ensureAppRole(client, appCredentials);

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

/**
 * Creates or updates the non-owner role the application connects as.
 *
 * Done here rather than in a .sql file so the credentials come from the
 * environment and never sit in version control. NOSUPERUSER / NOBYPASSRLS are
 * stated explicitly: they are the reason the policies in 030-rls.sql have any
 * force at all.
 */
async function ensureAppRole(
  client: postgres.Sql,
  { username, password }: AppCredentials,
): Promise<void> {
  const exists = await client`SELECT 1 FROM pg_roles WHERE rolname = ${username}`;

  // Role names cannot be parameterised in DDL, so the identifier is quoted by
  // the driver rather than interpolated raw.
  const roleIdent = client(username);

  if (exists.length === 0) {
    await client`CREATE ROLE ${roleIdent} LOGIN PASSWORD ${client.unsafe(quoteLiteral(password))}`;
  } else {
    await client`ALTER ROLE ${roleIdent} LOGIN PASSWORD ${client.unsafe(quoteLiteral(password))}`;
  }

  await client`ALTER ROLE ${roleIdent} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`;
}

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
