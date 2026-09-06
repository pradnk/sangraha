/**
 * Provisioning an organisation, and the setup guide that follows it.
 *
 * The guide derives every step from real data rather than a stored flag, so
 * these tests walk an organisation from empty to set up and check the guide
 * keeps pace — including that a step un-completes if the thing is undone.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  deriveOrgSlug,
  dismissSetupGuide,
  getSetupProgress,
  provisionOrganisation,
} from '../admin/provision-organisation';
import { deleteOrganisationBySlug } from '../admin/delete-organisation';
import { login } from '../auth/login';
import { WeakPinError } from '../auth/pin';
import { addField, createForm, getOrCreateDraft, publishDraft } from '../queries/form-builder';
import { addLocation, updateOrgSettings } from '../queries/admin-locations';
import { updateOrgIdentity } from '../queries/organisation-identity';
import { createUser } from '../queries/admin-users';
import { organisations, submissions } from '../schema/index';
import { closeHarness, hasDatabase, ownerDb } from './harness';

const created: string[] = [];

async function provision(name: string, overrides = {}) {
  const result = await provisionOrganisation(ownerDb(), {
    name,
    adminUsername: 'founder',
    adminFullName: 'The Founder',
    adminPin: '451237',
    mustChangePin: false,
    ...overrides,
  });
  if (result.ok) created.push(result.slug);
  return result;
}

describe('slug derivation', () => {
  it('makes a URL-safe slug from an ordinary name', () => {
    expect(deriveOrgSlug('Shiksha Foundation')).toBe('shiksha-foundation');
    expect(deriveOrgSlug('Asha Trust (Pune)')).toBe('asha-trust-pune');
    expect(deriveOrgSlug('  Spaces   Everywhere  ')).toBe('spaces-everywhere');
  });
});

describe.skipIf(!hasDatabase)('provisioning an organisation', () => {
  afterAll(async () => {
    for (const slug of created) await deleteOrganisationBySlug(ownerDb(), slug);
    await closeHarness();
  });

  it('creates the organisation with its founder as administrator', async () => {
    const result = await provision('Asha Trust');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.slug).toBe('asha-trust');

    // The founder can sign in immediately with the PIN they chose.
    const signIn = await login(ownerDb(), {
      orgSlug: result.slug,
      username: 'founder',
      pin: '451237',
    });

    expect(signIn.ok).toBe(true);
    if (signIn.ok) {
      expect(signIn.user.role).toBe('org_admin');
      // They chose it themselves, so there is nothing to force them to replace.
      expect(signIn.user.mustChangePin).toBe(false);
    }
  });

  it('always enables English, first', async () => {
    // English is the fallback when an organisation's own content is untranslated.
    // Without it there would be gaps with nothing behind them.
    const result = await provision('Kannada Only', { locales: ['kn'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [org] = await ownerDb()
      .select({ locales: organisations.enabledLocales, def: organisations.defaultLocale })
      .from(organisations)
      .where(eq(organisations.id, result.orgId));

    expect(org?.locales[0]).toBe('en');
    expect(org?.locales).toContain('kn');
    expect(org?.def).toBe('en');
  });

  it('refuses a name that collides with an existing organisation', async () => {
    await provision('Twice Over');
    const second = await provision('Twice Over');

    expect(second).toMatchObject({ ok: false, reason: 'slug_taken' });
  });

  describe('a rejected PIN', () => {
    /*
     * The bug these exist for: the organisation was inserted first and the PIN
     * hashed afterwards, with no transaction. Somebody signing up with 111111
     * got an error *and* a committed organisation that had no administrator
     * and that nobody could sign into — so their second attempt was refused
     * for a name that "already existed", which was their own wreckage from the
     * first.
     */
    it('leaves no organisation behind', async () => {
      const attempt = provisionOrganisation(ownerDb(), {
        name: 'Weak Pin Org',
        adminUsername: 'founder',
        adminPin: '111111',
      });

      await expect(attempt).rejects.toThrow(WeakPinError);

      const rows = await ownerDb()
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.slug, 'weak-pin-org'));

      expect(rows).toHaveLength(0);
    });

    it('lets the same name through on the next attempt', async () => {
      // The second bad outcome: being told your own failed attempt already
      // took the name.
      await expect(
        provisionOrganisation(ownerDb(), {
          name: 'Second Try Org',
          adminUsername: 'founder',
          adminPin: '123456',
        }),
      ).rejects.toThrow(WeakPinError);

      const retry = await provision('Second Try Org', { adminPin: '451237' });
      expect(retry.ok).toBe(true);
    });

    it.each([
      { pin: '111111', reason: 'too_common' },
      { pin: '123456', reason: 'too_common' },
      { pin: '12345', reason: 'too_short' },
      { pin: '1234567890123', reason: 'too_long' },
      { pin: 'abcdef', reason: 'not_numeric' },
    ])('says why $pin was refused', async ({ pin, reason }) => {
      // The screen turns each of these into a different sentence, so one
      // catch-all reason would make the message a guess.
      await expect(
        provisionOrganisation(ownerDb(), {
          name: `Pin Reason ${reason} ${pin}`,
          adminUsername: 'founder',
          adminPin: pin,
        }),
      ).rejects.toMatchObject({ name: 'WeakPinError', reason });
    });

    it('is checked before anything is written, not after', async () => {
      // A weak PIN must cost nothing — no rollback, and no Argon2 hash to find
      // out. Asserted by there being no trace of the attempt at all.
      await expect(
        provisionOrganisation(ownerDb(), {
          name: 'Nothing Written Org',
          adminUsername: 'founder',
          adminPin: '000000',
        }),
      ).rejects.toThrow(WeakPinError);

      const [org] = await ownerDb()
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.slug, 'nothing-written-org'));
      expect(org).toBeUndefined();
    });
  });

  it('never leaves an organisation without an administrator', async () => {
    /*
     * An organisation nobody can sign into is not a half-success — it is
     * wreckage that also holds the name hostage. Scoped to the names this test
     * attempts rather than sweeping the whole database, which would fail on
     * whatever else happens to be in a developer's dev instance and would not
     * be testing this code at all.
     */
    const attempts = ['Orphan Check A', 'Orphan Check B', 'Orphan Check C'];

    for (const name of attempts) {
      await expect(
        provisionOrganisation(ownerDb(), {
          name,
          adminUsername: 'founder',
          adminPin: '111111',
        }),
      ).rejects.toThrow(WeakPinError);
    }

    const survivors = await ownerDb()
      .select({ slug: organisations.slug })
      .from(organisations)
      .where(inArray(organisations.slug, attempts.map(deriveOrgSlug)));

    // Not merely "no orphans" — no rows at all. A failed signup should leave
    // the name free for the person's second attempt.
    expect(survivors).toEqual([]);
  });

  it('refuses a name with no usable characters', async () => {
    const result = await provisionOrganisation(ownerDb(), {
      name: '!!!',
      adminUsername: 'nobody',
      adminPin: '451237',
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_slug' });
  });

  it('forces a PIN change when the PIN was issued rather than chosen', async () => {
    const result = await provision('Issued Pin Org', { mustChangePin: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const signIn = await login(ownerDb(), {
      orgSlug: result.slug,
      username: 'founder',
      pin: '451237',
    });
    expect(signIn.ok && signIn.user.mustChangePin).toBe(true);
  });
});

describe.skipIf(!hasDatabase)('the setup guide', () => {
  afterAll(async () => {
    for (const slug of created) await deleteOrganisationBySlug(ownerDb(), slug).catch(() => {});
    await closeHarness();
  });

  it('tracks each step as it is actually completed', async () => {
    const db = ownerDb();
    const org = await provision('Progress Org');
    expect(org.ok).toBe(true);
    if (!org.ok) return;

    const progress = () => getSetupProgress(db, org.orgId);

    // Nothing done but the organisation itself.
    let now = await progress();
    expect(now).toMatchObject({
      hasPlaces: false,
      hasForm: false,
      hasPublishedForm: false,
      hasTeam: false,
      hasSubmission: false,
      hasExtraLanguage: false,
      hasPrivacyContact: false,
      dismissed: false,
    });

    const placeId = await addLocation(db, org.orgId, { parentId: null, name: { en: 'District' } });
    expect((await progress()).hasPlaces).toBe(true);

    const formId = await createForm(db, org.orgId, {
      slug: 'first_form',
      name: { en: 'First form' },
      formType: 'standalone',
    });
    now = await progress();
    expect(now.hasForm).toBe(true);
    // Creating is not publishing — field workers still have nothing.
    expect(now.hasPublishedForm).toBe(false);

    const draft = await getOrCreateDraft(db, formId, org.userId);
    await addField(db, draft, { label: { en: 'A question' }, dataType: 'short_text' });
    await publishDraft(db, formId, org.userId);
    expect((await progress()).hasPublishedForm).toBe(true);

    // The founder alone is not a team.
    expect((await progress()).hasTeam).toBe(false);
    await createUser(db, org.orgId, {
      username: 'worker',
      fullName: 'A Worker',
      role: 'field_worker',
      temporaryPin: '918273',
      locationIds: [placeId],
    });
    expect((await progress()).hasTeam).toBe(true);

    await updateOrgSettings(db, org.orgId, { enabledLocales: ['en', 'hi'] });
    expect((await progress()).hasExtraLanguage).toBe(true);

    /*
     * A name with no way to reach it is not a contact — the step stays open
     * until somebody can actually be complained to.
     */
    await updateOrgIdentity(db, org.orgId, { grievanceOfficerName: 'Sunita Devi' });
    expect((await progress()).hasPrivacyContact).toBe(false);

    await updateOrgIdentity(db, org.orgId, { grievanceOfficerPhone: '9876543210' });
    expect((await progress()).hasPrivacyContact).toBe(true);

    // And it un-completes if the contact is removed, like every other step here.
    await updateOrgIdentity(db, org.orgId, { grievanceOfficerPhone: null });
    expect((await progress()).hasPrivacyContact).toBe(false);
    await updateOrgIdentity(db, org.orgId, { grievanceOfficerEmail: 'grievance@example.org' });
    expect((await progress()).hasPrivacyContact).toBe(true);

    const [version] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.orgId, org.orgId))
      .limit(1);
    expect(version).toBeUndefined();

    await db.insert(submissions).values({
      orgId: org.orgId,
      formId,
      formVersionId: draft,
      submittedBy: org.userId,
      clientUuid: crypto.randomUUID(),
      data: { a_question: 'tried it' },
    });
    expect((await progress()).hasSubmission).toBe(true);
  });

  it('un-completes a step when the thing is undone', async () => {
    // Derived from data rather than a flag, so turning a language back off has
    // to be reflected — otherwise the guide lies.
    const db = ownerDb();
    const org = await provision('Undo Org');
    if (!org.ok) return;

    await updateOrgSettings(db, org.orgId, { enabledLocales: ['en', 'kn'] });
    expect((await getSetupProgress(db, org.orgId)).hasExtraLanguage).toBe(true);

    await updateOrgSettings(db, org.orgId, { enabledLocales: ['en'] });
    expect((await getSetupProgress(db, org.orgId)).hasExtraLanguage).toBe(false);
  });

  it('remembers that the banner was dismissed', async () => {
    const db = ownerDb();
    const org = await provision('Dismiss Org');
    if (!org.ok) return;

    expect((await getSetupProgress(db, org.orgId)).dismissed).toBe(false);
    await dismissSetupGuide(db, org.orgId);
    expect((await getSetupProgress(db, org.orgId)).dismissed).toBe(true);
  });
});
