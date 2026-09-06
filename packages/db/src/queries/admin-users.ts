import { randomInt } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { I18nText } from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { locations, userLocations, users } from '../schema/tenancy';
import { hashPin } from '../auth/pin';

/**
 * User administration.
 *
 * Two rules run through all of it. First, `token_version` is bumped whenever a
 * user's access changes — sessions are stateless JWTs, so that bump is the only
 * thing that makes "reset this PIN" or "switch this person off" take effect
 * before the token would otherwise expire. Second, a PIN an administrator sets
 * is always temporary: `must_change_pin` forces the worker to replace it, so a
 * supervisor never durably knows a colleague's credentials.
 */

export type UserRole = 'field_worker' | 'supervisor' | 'org_admin' | 'super_admin';

export interface AdminUserSummary {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  locale: string | null;
  isActive: boolean;
  mustChangePin: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  locations: { id: string; name: I18nText }[];
}

export async function listUsers(db: DbLike, orgId: string): Promise<AdminUserSummary[]> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      locale: users.locale,
      isActive: users.isActive,
      mustChangePin: users.mustChangePin,
      lockedUntil: users.lockedUntil,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(asc(users.username));

  const assignments = await db
    .select({
      userId: userLocations.userId,
      locationId: locations.id,
      name: locations.name,
    })
    .from(userLocations)
    .innerJoin(locations, eq(locations.id, userLocations.locationId))
    .where(eq(locations.orgId, orgId));

  return rows.map((row) => ({
    ...row,
    locations: assignments
      .filter((a) => a.userId === row.id)
      .map((a) => ({ id: a.locationId, name: a.name })),
  }));
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  role: UserRole;
  temporaryPin: string;
  locationIds?: string[];
  locale?: string | null;
}

export type CreateUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'username_taken' };

export async function createUser(
  db: DbLike,
  orgId: string,
  input: CreateUserInput,
): Promise<CreateUserResult> {
  const username = input.username.trim().toLowerCase();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), sql`lower(${users.username}) = ${username}`))
    .limit(1);
  if (existing) return { ok: false, reason: 'username_taken' };

  const [created] = await db
    .insert(users)
    .values({
      orgId,
      username,
      fullName: input.fullName.trim(),
      role: input.role,
      pinHash: await hashPin(input.temporaryPin),
      locale: input.locale ?? null,
      // Always true for an administrator-issued PIN.
      mustChangePin: true,
    })
    .returning({ id: users.id });

  if (input.locationIds?.length) {
    await db
      .insert(userLocations)
      .values(input.locationIds.map((locationId) => ({ userId: created!.id, locationId })));
  }

  return { ok: true, userId: created!.id };
}

export async function updateUser(
  db: DbLike,
  userId: string,
  patch: { fullName?: string; role?: UserRole; locale?: string | null },
): Promise<void> {
  const changesAccess = patch.role !== undefined;

  await db
    .update(users)
    .set({
      ...patch,
      updatedAt: new Date(),
      // A role change alters what the session is allowed to do, and the role is
      // carried *inside* the token — so an unbumped session would keep its old
      // permissions until it expired.
      ...(changesAccess ? { tokenVersion: sql`${users.tokenVersion} + 1` } : {}),
    })
    .where(eq(users.id, userId));
}

export async function setUserActive(
  db: DbLike,
  userId: string,
  isActive: boolean,
): Promise<void> {
  await db
    .update(users)
    .set({
      isActive,
      updatedAt: new Date(),
      // Deactivation has to end the session now, not whenever the token lapses.
      tokenVersion: sql`${users.tokenVersion} + 1`,
      ...(isActive ? { failedAttempts: 0, lockedUntil: null } : {}),
    })
    .where(eq(users.id, userId));
}

export async function setUserLocations(
  db: DbLike,
  userId: string,
  locationIds: string[],
): Promise<void> {
  await db.delete(userLocations).where(eq(userLocations.userId, userId));
  if (locationIds.length > 0) {
    await db.insert(userLocations).values(locationIds.map((locationId) => ({ userId, locationId })));
  }
}

/** Clears a lockout without changing the PIN, for the "I mistyped it" case. */
export async function unlockUser(db: DbLike, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * A readable temporary PIN.
 *
 * Six digits, avoiding the sequences and repeats the strength policy rejects,
 * because an administrator has to read this out over a phone and a worker has to
 * type it once.
 *
 * `randomInt` rather than `Math.random`. This is a credential for a live account
 * on a live tenant from the moment it is issued until the worker changes it, and
 * `Math.random` is a PRNG whose internal state is recoverable from a short run
 * of its output — so PINs issued in one session would predict the next. The
 * readability constraint is about the digits, not about where they come from.
 *
 * `randomInt(10)` per digit rather than one number formatted to six places: the
 * latter drops leading zeros, and `042917` is a valid PIN.
 */
export function generateTemporaryPin(): string {
  const digits = () => Array.from({ length: 6 }, () => randomInt(10)).join('');
  let pin = digits();
  // Reject the shapes `assertPinAcceptable` would refuse, so an issued PIN can
  // never fail to be set.
  while (/^(\d)\1*$/.test(pin) || '01234567890123456789'.includes(pin) || '09876543210987654321'.includes(pin)) {
    pin = digits();
  }
  return pin;
}
