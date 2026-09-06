import 'server-only';
import { count } from 'drizzle-orm';
import { getOwnerDb, organisations } from '@sangraha/db';

/**
 * Who may create an organisation.
 *
 * Two things are in tension. An open signup endpoint on a public URL lets
 * anyone create tenants in someone else's database. But the production target
 * is Vercel, where there is no shell — so `npm run org:create` is not available
 * to the person who just deployed, and a strictly closed door would lock them
 * out of their own installation.
 *
 * Resolved by treating the empty database as the bootstrap case: signup is
 * always permitted while no organisation exists. Whoever deploys visits
 * `/start`, becomes the administrator, and the door shuts behind them. After
 * that it is closed unless deliberately opened.
 *
 *   open    anyone with the URL. Right for a trial or an internal network.
 *   code    a shared code is required. Right for onboarding known partners.
 *   closed  first organisation only, then nobody. The production default.
 */
export type SignupMode = 'open' | 'code' | 'closed';

/** The configured code, or null when there is nothing to check against. */
function configuredCode(): string | null {
  const code = process.env.SIGNUP_CODE?.trim();
  return code ? code : null;
}

export function signupMode(): SignupMode {
  const configured = process.env.SIGNUP_MODE?.trim().toLowerCase();
  const code = configuredCode();

  if (configured === 'closed') return 'closed';
  if (configured === 'open') return 'open';

  if (configured === 'code' || code) {
    /*
     * `SIGNUP_MODE=code` with no code set is not a gate — it is an open door
     * with a lock painted on it.
     *
     * This used to report `code`, which made `requiresCode` true, which put a
     * code box on `/start` — and `signupCodeMatches` then accepted anything,
     * including an empty string. An operator who set the mode and left the
     * value blank got a fully public signup that *looked* protected, which is
     * worse than one that plainly is not.
     *
     * Closed rather than open, because the intent was clearly to restrict.
     * Loud, because the bootstrap exemption below means an empty installation
     * still lets the operator in, and a silent downgrade would look like it
     * worked until the second organisation was refused.
     */
    if (!code) {
      console.error(
        'SIGNUP_MODE=code but SIGNUP_CODE is empty. Signup is closed. ' +
          'Set SIGNUP_CODE to the shared code, or set SIGNUP_MODE=open deliberately.',
      );
      return 'closed';
    }
    return 'code';
  }

  /*
   * Closed in production, open in development.
   *
   * The previous default was open everywhere, which meant a deployment was
   * insecure unless its operator had read the right paragraph. Defaults should
   * not depend on that.
   */
  return process.env.NODE_ENV === 'production' ? 'closed' : 'open';
}

/**
 * Whether the supplied code is the configured one.
 *
 * No code configured means nothing matches, rather than everything matching.
 * `signupMode` above no longer lets a code-gated installation reach this
 * function with nothing to compare against, and this is the second lock on the
 * same door: a caller that checks the code without checking the mode gets a
 * refusal rather than a waiver.
 */
export function signupCodeMatches(supplied: string | undefined): boolean {
  const expected = configuredCode();
  if (!expected) return false;
  return typeof supplied === 'string' && supplied.trim() === expected;
}

/** True when no organisation exists yet, so this is a first-run setup. */
export async function isFirstRun(): Promise<boolean> {
  const [row] = await getOwnerDb().select({ total: count() }).from(organisations);
  return Number(row?.total ?? 0) === 0;
}

export interface SignupAvailability {
  allowed: boolean;
  mode: SignupMode;
  /** True when this is permitted only because the installation is empty. */
  bootstrap: boolean;
  requiresCode: boolean;
}

/**
 * Whether signup may proceed right now.
 *
 * Hits the database, because the bootstrap exemption depends on how many
 * organisations exist — which is exactly the sort of thing that must not be
 * cached into a stale "yes".
 */
export async function signupAvailability(): Promise<SignupAvailability> {
  const mode = signupMode();

  if (mode === 'open') {
    return { allowed: true, mode, bootstrap: false, requiresCode: false };
  }

  if (mode === 'code') {
    return { allowed: true, mode, bootstrap: false, requiresCode: true };
  }

  // Closed: permitted only while there is nothing here yet.
  const bootstrap = await isFirstRun();
  return { allowed: bootstrap, mode, bootstrap, requiresCode: false };
}
