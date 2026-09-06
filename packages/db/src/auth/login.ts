import { and, eq, sql } from 'drizzle-orm';
import type { DbLike } from '../client';
import { organisations, users } from '../schema/index';
import { createDecoyHash, verifyPin, hashPin } from './pin';

/**
 * Username + PIN authentication.
 *
 * Runs on the owner connection, before any tenant context exists — there is no
 * session yet to derive one from. It is the one place that legitimately reads
 * across organisations, and it does so only by (org slug, username).
 */

export interface LoginInput {
  orgSlug: string;
  username: string;
  pin: string;
}

export interface AuthenticatedUser {
  userId: string;
  orgId: string;
  orgSlug: string;
  username: string;
  fullName: string;
  role: 'field_worker' | 'supervisor' | 'org_admin' | 'super_admin';
  /** Null when the user has never chosen one — the caller then falls back. */
  locale: string | null;
  mustChangePin: boolean;
  tokenVersion: number;
}

export type LoginResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'inactive' };

const maxAttempts = () => Number(process.env.PIN_MAX_ATTEMPTS ?? 5);
const lockoutMinutes = () => Number(process.env.PIN_LOCKOUT_MINUTES ?? 15);

/**
 * A dummy argon2 hash, verified against when no such user exists.
 *
 * Without it, a missing username returns in microseconds while a wrong PIN
 * takes ~100ms, and that gap enumerates valid usernames. Computed once, lazily.
 */
let decoyHash: string | undefined;
async function getDecoyHash(): Promise<string> {
  decoyHash ??= await createDecoyHash();
  return decoyHash;
}

type PinRejection =
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number };

/** How long a lock still has to run, in whole seconds. */
const remainingLock = (until: Date): number => Math.ceil((until.getTime() - Date.now()) / 1000);

/** Whether this account is currently shut, without spending a hash to find out. */
function lockedNow(user: { lockedUntil: Date | null }): PinRejection | null {
  if (!user.lockedUntil || user.lockedUntil <= new Date()) return null;
  return { ok: false, reason: 'locked', retryAfterSeconds: remainingLock(user.lockedUntil) };
}

/**
 * Records one wrong PIN, and shuts the account if that was the last allowance.
 *
 * Shared by `login` and `changePin` because the threshold is a property of the
 * PIN, not of the screen it was typed into. `changePin` had no counter at all,
 * which left the whole six-digit space open to anyone holding an unlocked
 * phone — a shared device left on a table in a village, which is the ordinary
 * case here rather than an exotic one.
 *
 * A locked account is reported as locked rather than as a bad PIN: the worker
 * needs to know to wait or call their supervisor, and an attacker learns
 * nothing they could not infer from being unable to proceed.
 */
async function registerFailedAttempt(
  db: DbLike,
  user: { id: string; failedAttempts: number },
): Promise<PinRejection> {
  const attempts = user.failedAttempts + 1;
  const shouldLock = attempts >= maxAttempts();

  await db
    .update(users)
    .set({
      failedAttempts: shouldLock ? 0 : attempts,
      lockedUntil: shouldLock ? new Date(Date.now() + lockoutMinutes() * 60_000) : null,
    })
    .where(eq(users.id, user.id));

  return shouldLock
    ? { ok: false, reason: 'locked', retryAfterSeconds: lockoutMinutes() * 60 }
    : { ok: false, reason: 'invalid_credentials' };
}

export async function login(db: DbLike, input: LoginInput): Promise<LoginResult> {
  const username = input.username.trim().toLowerCase();

  const [row] = await db
    .select({ user: users, orgSlug: organisations.slug, orgActive: organisations.isActive })
    .from(users)
    .innerJoin(organisations, eq(organisations.id, users.orgId))
    .where(and(eq(organisations.slug, input.orgSlug), sql`lower(${users.username}) = ${username}`))
    .limit(1);

  if (!row) {
    // Spend comparable time before failing, so timing does not reveal whether
    // the username exists.
    await verifyPin(await getDecoyHash(), input.pin);
    return { ok: false, reason: 'invalid_credentials' };
  }

  const { user } = row;

  if (!user.isActive || !row.orgActive) {
    return { ok: false, reason: 'inactive' };
  }

  const shut = lockedNow(user);
  if (shut) return shut;

  const valid = await verifyPin(user.pinHash, input.pin);

  if (!valid) return registerFailedAttempt(db, user);

  await db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  return {
    ok: true,
    user: {
      userId: user.id,
      orgId: user.orgId,
      orgSlug: row.orgSlug,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      locale: user.locale,
      mustChangePin: user.mustChangePin,
      tokenVersion: user.tokenVersion,
    },
  };
}

/**
 * Replaces a user's own PIN.
 *
 * Bumps `tokenVersion`, which signs out every other device — the expected
 * behaviour when a shared phone changes hands.
 */
export async function changePin(
  db: DbLike,
  userId: string,
  currentPin: string,
  newPin: string,
): Promise<{ ok: true } | PinRejection> {
  const [user] = await db
    .select({
      id: users.id,
      pinHash: users.pinHash,
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { ok: false, reason: 'invalid_credentials' };

  // Counted and capped exactly as on the sign-in screen. Being signed in is not
  // a reason to allow unlimited guesses at the PIN: this screen is reached from
  // a phone somebody else may be holding.
  const shut = lockedNow(user);
  if (shut) return shut;

  if (!(await verifyPin(user.pinHash, currentPin))) {
    return registerFailedAttempt(db, user);
  }

  await db
    .update(users)
    .set({
      pinHash: await hashPin(newPin),
      mustChangePin: false,
      failedAttempts: 0,
      lockedUntil: null,
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, userId));

  return { ok: true };
}

/**
 * Supervisor-issued PIN reset.
 *
 * The replacement is temporary: `mustChangePin` forces the worker to set their
 * own before they can capture anything, so a supervisor never durably knows a
 * colleague's PIN.
 */
export async function resetPin(db: DbLike, userId: string, temporaryPin: string): Promise<void> {
  await db
    .update(users)
    .set({
      pinHash: await hashPin(temporaryPin),
      mustChangePin: true,
      failedAttempts: 0,
      lockedUntil: null,
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, userId));
}
