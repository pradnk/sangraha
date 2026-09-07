import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Loads the repo-root `.env` into `process.env`, then canonicalises whatever
 * the host injected under its own names.
 *
 * One env file for the whole monorepo. Next.js only reads a `.env` beside its
 * own package.json, and vitest reads none at all, so both call this instead of
 * each keeping a copy of the same secrets.
 *
 * Existing variables always win. In production — Docker, Fly, Vercel — the
 * environment is the source of truth and there is no file; this must never
 * clobber it.
 */
export function loadRootEnv() {
  try {
    const contents = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      if (key in process.env) continue;
      process.env[key] = trimmed.slice(separator + 1).trim();
    }
  } catch {
    // No .env is expected in production and fine in CI.
  }

  resolveDatabaseEnv();
}

/** The default name of the non-owner role that serves requests. */
export const DEFAULT_APP_ROLE = 'mis_app';

/**
 * Connection strings a provider integration may have set instead of ours.
 *
 * Supabase's Vercel integration injects a `POSTGRES_*` set and no
 * `DATABASE_URL`, so a project that worked on Neon stops at
 * `DATABASE_URL is not set` with the connection details sitting right there
 * under different names. Mapping them here rather than at each of the dozen
 * `process.env.DATABASE_URL` reads means the rest of the codebase never learns
 * that providers disagree about naming.
 *
 * Ordered by what the owner connection actually needs. `POSTGRES_URL` is the
 * pooler, which is the only one reachable from a Vercel function: Supabase's
 * direct host (`POSTGRES_URL_NON_POOLING`) resolves to IPv6 only unless the
 * IPv4 add-on is on, and Vercel functions have no IPv6 egress. It is still
 * listed, because it is the right and often the only answer off Vercel.
 *
 * `POSTGRES_PRISMA_URL` is deliberately absent. It is the same database with
 * `connection_limit` and `pgbouncer` bolted on for a driver we do not use, and
 * both would reach the server as startup parameters — see stripDriverMarkers.
 */
const OWNER_URL_SOURCES = ['POSTGRES_URL', 'POSTGRES_URL_NON_POOLING'];

/**
 * Query parameters that must not survive into a connection string.
 *
 * postgres.js forwards every query parameter it does not itself recognise to
 * the server as a startup parameter (`parseOptions` in postgres/src/index.js
 * builds `connection` from exactly the leftovers). Postgres answers an unknown
 * one with `FATAL: unrecognized configuration parameter`, so a string copied
 * verbatim out of a provider dashboard fails to connect at all — and the error
 * names the parameter, not the provider that added it.
 *
 * These are markers for other tools: `supa` is Supabase's own pooler tag,
 * `pgbouncer` and `connection_limit` are Prisma's. Removing them changes
 * nothing about where the connection goes, which is decided by the host, the
 * port and the tenant in the username.
 */
const DRIVER_MARKERS = ['supa', 'pgbouncer', 'connection_limit', 'pool_timeout', 'schema'];

/**
 * Fills in `DATABASE_URL` and `DATABASE_APP_URL` from whatever is present.
 *
 * Exported for the tests, which is the only way to check a mapping whose whole
 * job is to be invisible. Anything already set is left exactly alone.
 */
export function resolveDatabaseEnv(env = process.env) {
  const notes = [];

  if (!present(env.DATABASE_URL)) {
    const source = OWNER_URL_SOURCES.find((key) => present(env[key]));
    const assembled = source ? env[source] : assembleFromParts(env);
    if (assembled) {
      env.DATABASE_URL = stripDriverMarkers(assembled);
      notes.push(`DATABASE_URL from ${source ?? 'POSTGRES_HOST/USER/PASSWORD'}`);
    }
  } else {
    const cleaned = stripDriverMarkers(env.DATABASE_URL);
    if (cleaned !== env.DATABASE_URL) {
      env.DATABASE_URL = cleaned;
      notes.push('DATABASE_URL: dropped driver-specific query parameters');
    }
  }

  if (present(env.DATABASE_APP_URL)) {
    const cleaned = stripDriverMarkers(env.DATABASE_APP_URL);
    if (cleaned !== env.DATABASE_APP_URL) {
      env.DATABASE_APP_URL = cleaned;
      notes.push('DATABASE_APP_URL: dropped driver-specific query parameters');
    }
  } else if (present(env.DATABASE_APP_PASSWORD) && present(env.DATABASE_URL)) {
    /*
     * The application role differs from the owner only in its name and
     * password: same host, same database, same pooler. Deriving it means a
     * managed provider that hands out one connection string needs one extra
     * secret rather than a hand-assembled URL — and hand-assembling it is
     * where the tenant suffix below gets left off.
     *
     * Only ever from an explicit DATABASE_APP_PASSWORD. There is no fallback
     * to the owner's password on purpose: that would silently serve every
     * request on the connection that bypasses RLS, which is the one failure
     * this whole two-role arrangement exists to prevent, and it would look
     * like everything working.
     */
    const derived = applicationUrl(
      env.DATABASE_URL,
      env.DATABASE_APP_ROLE?.trim() || DEFAULT_APP_ROLE,
      env.DATABASE_APP_PASSWORD,
    );
    if (derived) {
      env.DATABASE_APP_URL = derived;
      notes.push('DATABASE_APP_URL derived from DATABASE_URL + DATABASE_APP_PASSWORD');
    }
  }

  // Said once, at startup, because a connection resolved from a name nobody
  // set is otherwise impossible to tell apart from one that was configured.
  if (notes.length > 0 && env.DATABASE_ENV_QUIET !== '1') {
    for (const note of notes) console.log(`  env: ${note}`);
  }

  return notes;
}

const present = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The host part of Supabase's shared pooler.
 *
 * Every connection through it carries the project reference in the username —
 * `postgres.abcdefgh`, not `postgres` — because one pooler fronts every
 * project and that suffix is how it decides which one. The role Postgres
 * actually authenticates is the part before the dot.
 */
const POOLER_HOST_SUFFIX = '.pooler.supabase.com';

/** The project reference in a pooler username, or null anywhere else. */
export function poolerTenant(connectionString) {
  const url = parse(connectionString);
  if (!url || !url.hostname.endsWith(POOLER_HOST_SUFFIX)) return null;
  const username = decodeURIComponent(url.username);
  const dot = username.indexOf('.');
  return dot === -1 ? null : username.slice(dot + 1) || null;
}

/**
 * The same connection as a different role.
 *
 * Keeps the tenant suffix if there is one, because a pooler connection without
 * it is refused, and an app URL is exactly the thing someone assembles by hand
 * and leaves it off.
 */
export function applicationUrl(ownerUrl, role, password) {
  const url = parse(ownerUrl);
  if (!url) return null;
  const tenant = poolerTenant(ownerUrl);
  // Assigned raw: the URL setters apply userinfo percent-encoding themselves,
  // so encoding first would double-encode a password containing @ / : or #.
  url.username = tenant ? `${role}.${tenant}` : role;
  url.password = password;
  return url.toString();
}

function assembleFromParts(env) {
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST } = env;
  if (!present(POSTGRES_USER) || !present(POSTGRES_PASSWORD) || !present(POSTGRES_HOST)) {
    return null;
  }
  const url = new URL(`postgres://${POSTGRES_HOST}/${env.POSTGRES_DATABASE?.trim() || 'postgres'}`);
  url.username = POSTGRES_USER;
  url.password = POSTGRES_PASSWORD;
  return url.toString();
}

function stripDriverMarkers(connectionString) {
  const url = parse(connectionString);
  if (!url) return connectionString;
  for (const marker of DRIVER_MARKERS) url.searchParams.delete(marker);
  // Keeps a string with no parameters looking like it did, rather than
  // acquiring a bare trailing '?'.
  return url.search === '?' ? url.toString().replace('?', '') : url.toString();
}

function parse(value) {
  try {
    return new URL(value);
  } catch {
    // Not our business to validate here — the driver reports a bad URL far
    // better than this could, and at the point where someone is looking.
    return null;
  }
}
