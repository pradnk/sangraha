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

/** Matches the local development default in `.env.example`. */
const FALLBACK = 'mis_app';

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

export function appRoleName(): string {
  return usernameFrom(process.env.DATABASE_APP_URL) ?? FALLBACK;
}
