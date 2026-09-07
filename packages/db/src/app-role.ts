/**
 * The name of the database role the application connects as.
 *
 * There is exactly one definition of this because there used to be three that
 * did not agree: `030-grants.sql` granted to a literal `mis_app`, the analytics
 * generator granted to a literal `mis_app`, and `migrate.ts` created whatever
 * role `DATABASE_APP_URL` happened to name. A deployment that picked any other
 * username migrated cleanly, reported success, and left the application role
 * with no privileges at all — every request failing on a permission error that
 * said nothing about the cause.
 *
 * Derived rather than configured separately, so it cannot drift from the URL
 * the application actually connects with.
 */
import { DEFAULT_APP_ROLE, poolerTenant } from '../../../load-env.mjs';

/*
 * The fallback name is `DEFAULT_APP_ROLE`, defined in `load-env.mjs` and not
 * here, because that module also derives a `DATABASE_APP_URL` when only a
 * password was given — and a fallback that disagreed with the URL it derives
 * would recreate the exact drift this file exists to prevent. It has to live
 * there rather than here: `next.config.ts` imports it before any TypeScript
 * transform exists.
 */

/**
 * The username from a Postgres connection string.
 *
 * Returns null rather than throwing: this is used by the analytics generator,
 * which runs inside a request and must not fail because an environment variable
 * is shaped oddly. The caller falls back.
 */
function usernameFrom(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const username = decodeURIComponent(new URL(url).username);
    return username || null;
  } catch {
    return null;
  }
}

/**
 * The role name a connection string authenticates as.
 *
 * Usually the username, and on Supabase's shared pooler it is not. One pooler
 * fronts every project there, so the project reference is carried in the
 * username — `mis_app.abcdefgh` — and stripped back off before the connection
 * reaches Postgres, which sees plain `mis_app`.
 *
 * Getting this wrong is silent in the worst way. `CREATE ROLE` and every GRANT
 * in `030-grants.sql` would name a role literally called `mis_app.abcdefgh`,
 * the migration would report success, and then every request would arrive as
 * `mis_app` — a role with no privileges, or none at all.
 */
export function roleNameFor(url: string | undefined): string | null {
  const username = usernameFrom(url);
  if (!username || !url) return null;

  const tenant = poolerTenant(url);
  if (!tenant) return username;

  const role = username.slice(0, username.length - tenant.length - 1);
  return role || username;
}

/**
 * `DATABASE_APP_ROLE` overrides all of it, for a provider that mangles the
 * username in some way not covered above. It names the role Postgres sees, not
 * the string used to connect.
 */
export function appRoleName(): string {
  const explicit = process.env.DATABASE_APP_ROLE?.trim();
  if (explicit) return explicit;
  return roleNameFor(process.env.DATABASE_APP_URL) ?? DEFAULT_APP_ROLE;
}
