import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { changePin, login, resetPin } from '../auth/login';
import { WeakPinError, assertPinAcceptable, hashPin, verifyPin } from '../auth/pin';
import { users } from '../schema/index';
import { closeHarness, createTestOrg, dropTestOrg, hasDatabase, ownerDb, type TestOrg } from './harness';

describe('PIN policy', () => {
  it('rejects the PINs people actually pick', () => {
    for (const weak of ['111111', '123456', '000000', '654321']) {
      expect(() => assertPinAcceptable(weak), weak).toThrow(WeakPinError);
    }
  });

  it('rejects PINs that are too short to survive an offline sweep', () => {
    expect(() => assertPinAcceptable('1234')).toThrow(WeakPinError);
    expect(() => assertPinAcceptable('284917')).not.toThrow();
  });

  it('rejects non-numeric input', () => {
    expect(() => assertPinAcceptable('abc123')).toThrow(WeakPinError);
  });

  it('produces a verifiable hash that is not the PIN', async () => {
    const hash = await hashPin('284917');

    expect(hash).not.toContain('284917');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPin(hash, '284917')).toBe(true);
    expect(await verifyPin(hash, '284918')).toBe(false);
  });

  it('salts, so two users with the same PIN do not share a hash', async () => {
    const [a, b] = await Promise.all([hashPin('284917'), hashPin('284917')]);
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a corrupt hash', async () => {
    expect(await verifyPin('not-a-hash', '284917')).toBe(false);
  });
});

describe.skipIf(!hasDatabase)('login', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('auth');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  const attempt = (username: string, pin: string) =>
    login(ownerDb(), { orgSlug: org.slug, username, pin });

  const resetLockState = (userId: string) =>
    ownerDb().update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, userId));

  it('accepts a correct username and PIN', async () => {
    const result = await attempt('worker_a', '284917');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.role).toBe('field_worker');
      expect(result.user.orgId).toBe(org.id);
    }
  });

  it('is case-insensitive on the username', async () => {
    expect((await attempt('WORKER_A', '284917')).ok).toBe(true);
  });

  it('rejects a wrong PIN', async () => {
    const result = await attempt('worker_a', '999999');

    expect(result).toMatchObject({ ok: false, reason: 'invalid_credentials' });
    await resetLockState(org.workerAId);
  });

  it('gives the same answer for an unknown user as for a wrong PIN', async () => {
    // Anything else enumerates usernames.
    const unknown = await attempt('does_not_exist', '284917');
    expect(unknown).toMatchObject({ ok: false, reason: 'invalid_credentials' });
  });

  it('will not authenticate a user from another organisation', async () => {
    const other = await createTestOrg('auth-other');
    try {
      const result = await login(ownerDb(), {
        orgSlug: other.slug,
        username: 'worker_a',
        pin: '284917',
      });
      // `worker_a` exists in both orgs, so this must resolve to the *other*
      // org's user, never this one's.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.user.orgId).toBe(other.id);
    } finally {
      await dropTestOrg(other);
    }
  });

  it('locks the account after repeated failures and reports it', async () => {
    const maxAttempts = Number(process.env.PIN_MAX_ATTEMPTS ?? 5);

    let last = await attempt('worker_b', '999999');
    for (let i = 1; i < maxAttempts; i += 1) {
      last = await attempt('worker_b', '999999');
    }

    expect(last).toMatchObject({ ok: false, reason: 'locked' });

    // The correct PIN is refused while the lock stands — otherwise the lockout
    // would be trivially bypassable by guessing right on the next try.
    const whileLocked = await attempt('worker_b', '284917');
    expect(whileLocked).toMatchObject({ ok: false, reason: 'locked' });

    await resetLockState(org.workerBId);
    expect((await attempt('worker_b', '284917')).ok).toBe(true);
  });

  it('clears the failure count after a successful sign-in', async () => {
    await attempt('worker_a', '999999');
    await attempt('worker_a', '284917');

    const [row] = await ownerDb()
      .select({ failedAttempts: users.failedAttempts })
      .from(users)
      .where(eq(users.id, org.workerAId));

    expect(row?.failedAttempts).toBe(0);
  });

  it('reports no locale when the user has never chosen one', async () => {
    // The login screen's choice is only a fallback, so "unset" has to be
    // distinguishable from "English".
    await ownerDb().update(users).set({ locale: null }).where(eq(users.id, org.workerAId));
    const result = await attempt('worker_a', '284917');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.locale).toBeNull();
  });

  it('returns a saved locale so it survives signing out', async () => {
    // The bug this guards: the account screen wrote the language only to the
    // session cookie, so the setting vanished at sign-out and looked broken.
    await ownerDb().update(users).set({ locale: 'kn' }).where(eq(users.id, org.workerAId));
    const result = await attempt('worker_a', '284917');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.locale).toBe('kn');
  });

  it('refuses a deactivated user', async () => {
    await ownerDb().update(users).set({ isActive: false }).where(eq(users.id, org.workerAId));
    try {
      expect(await attempt('worker_a', '284917')).toMatchObject({ ok: false, reason: 'inactive' });
    } finally {
      await ownerDb().update(users).set({ isActive: true }).where(eq(users.id, org.workerAId));
    }
  });
});

describe.skipIf(!hasDatabase)('PIN changes', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('pin-change');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  const tokenVersion = async (userId: string) => {
    const [row] = await ownerDb()
      .select({ v: users.tokenVersion, mustChange: users.mustChangePin })
      .from(users)
      .where(eq(users.id, userId));
    return row!;
  };

  it('changes a PIN and invalidates existing sessions', async () => {
    const before = await tokenVersion(org.workerAId);

    const result = await changePin(ownerDb(), org.workerAId, '284917', '736251');
    expect(result.ok).toBe(true);

    const after = await tokenVersion(org.workerAId);
    // Bumping the version is what signs the old device out — the expected
    // behaviour when a shared phone changes hands.
    expect(after.v).toBe(before.v + 1);
    expect(after.mustChange).toBe(false);

    expect((await login(ownerDb(), { orgSlug: org.slug, username: 'worker_a', pin: '736251' })).ok).toBe(true);
    expect((await login(ownerDb(), { orgSlug: org.slug, username: 'worker_a', pin: '284917' })).ok).toBe(false);
  });

  it('refuses a change without the current PIN', async () => {
    const result = await changePin(ownerDb(), org.workerBId, 'wrong1', '736251');
    expect(result).toMatchObject({ ok: false, reason: 'invalid_credentials' });
  });

  it('locks the account after repeated wrong current PINs', async () => {
    /*
     * The gap: `login` counted attempts and `changePin` did not, so the whole
     * six-digit space was open to anybody holding an unlocked phone. On a
     * shared device left on a table in a village that is the ordinary case, not
     * an exotic one — and being signed in already is not a reason to allow
     * unlimited guesses at the credential that protects the account.
     */
    const maxAttempts = Number(process.env.PIN_MAX_ATTEMPTS ?? 5);
    const reset = () =>
      ownerDb()
        .update(users)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(users.id, org.supervisorId));

    await reset();

    let last = await changePin(ownerDb(), org.supervisorId, '000000', '736251');
    for (let i = 1; i < maxAttempts; i += 1) {
      last = await changePin(ownerDb(), org.supervisorId, '000000', '736251');
    }

    expect(last).toMatchObject({ ok: false, reason: 'locked' });

    // And the right PIN is refused while the lock stands, or the lockout would
    // be bypassable by simply guessing correctly on the next try.
    const whileLocked = await changePin(ownerDb(), org.supervisorId, '284917', '736251');
    expect(whileLocked).toMatchObject({ ok: false, reason: 'locked' });

    await reset();
  });

  it('shares its lockout with the sign-in screen rather than keeping its own', async () => {
    // One counter, because an attacker who can alternate between the two
    // screens gets twice the allowance from two.
    const reset = () =>
      ownerDb()
        .update(users)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(users.id, org.supervisorId));
    await reset();

    const maxAttempts = Number(process.env.PIN_MAX_ATTEMPTS ?? 5);
    for (let i = 0; i < maxAttempts - 1; i += 1) {
      await login(ownerDb(), { orgSlug: org.slug, username: 'supervisor', pin: '999999' });
    }

    // One more, on the other screen. It should be the last one.
    const last = await changePin(ownerDb(), org.supervisorId, '000000', '736251');
    expect(last).toMatchObject({ ok: false, reason: 'locked' });

    await reset();
  });

  it('clears the failure count when the PIN is successfully changed', async () => {
    await changePin(ownerDb(), org.supervisorId, '000000', '736251');

    const changed = await changePin(ownerDb(), org.supervisorId, '284917', '736251');
    expect(changed.ok).toBe(true);

    const [row] = await ownerDb()
      .select({ failedAttempts: users.failedAttempts, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.id, org.supervisorId));
    expect(row!.failedAttempts).toBe(0);
    expect(row!.lockedUntil).toBeNull();

    // Put it back, so the ordering of the tests around this one does not matter.
    await changePin(ownerDb(), org.supervisorId, '736251', '284917');
  });

  it('rejects a weak replacement', async () => {
    await expect(changePin(ownerDb(), org.workerBId, '284917', '111111')).rejects.toThrow(WeakPinError);
  });

  it('forces a worker to replace a supervisor-issued PIN', async () => {
    await resetPin(ownerDb(), org.workerBId, '918273');

    const result = await login(ownerDb(), { orgSlug: org.slug, username: 'worker_b', pin: '918273' });

    expect(result.ok).toBe(true);
    // The UI uses this to route straight to "choose your own PIN", so a
    // supervisor never durably knows a colleague's credentials.
    if (result.ok) expect(result.user.mustChangePin).toBe(true);
  });

  it('unlocks a locked account', async () => {
    await ownerDb()
      .update(users)
      .set({ lockedUntil: sql`now() + interval '1 hour'` })
      .where(eq(users.id, org.workerBId));

    await resetPin(ownerDb(), org.workerBId, '451236');

    expect(
      (await login(ownerDb(), { orgSlug: org.slug, username: 'worker_b', pin: '451236' })).ok,
    ).toBe(true);
  });
});
