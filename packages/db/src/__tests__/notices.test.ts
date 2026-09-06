/**
 * Purposes, and the privacy notice generated from them.
 *
 * The property that matters is that a published notice is frozen. A consent
 * record is only worth anything because it cites the exact words somebody was
 * read, so a notice that can be edited after the fact makes every past consent
 * unprovable — quietly, and without anything looking wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { composeNotice, describeField, hashNoticeText } from '@sangraha/form-engine';
import {
  createNotice,
  discardNotice,
  currentNotice,
  generateNoticeDraft,
  getNotice,
  getOrCreateNoticeDraft,
  listNotices,
  publishNotice,
  retractNoticeVersion,
  setNoticePurposes,
  updateNoticeDraft,
} from '../queries/consent-notices';
import {
  createPurpose,
  listPurposes,
  purposeCoverage,
  unattributedFields,
  REQUIRES_CONSENT,
} from '../queries/purposes';
import { updateOrgIdentity } from '../queries/organisation-identity';
import { getOrCreateDraft, publishDraft, validateDraft } from '../queries/form-builder';
import { consentNoticeVersions, formFields, subjectTypes } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe('composing a notice', () => {
  /* Pure, no database — this is the text a beneficiary actually hears. */
  const ORG = {
    legalName: 'Dharti Foundation',
    name: 'Dharti',
    grievanceOfficerName: 'Sunita Devi',
    grievanceOfficerEmail: null,
    grievanceOfficerPhone: '9876543210',
  };

  it('groups by purpose rather than listing every question', () => {
    /*
     * The constraint that decides the whole design. A forty-question form
     * becomes a forty-bullet notice, and a forty-bullet notice read aloud on a
     * doorstep is not heard — which makes the consent that follows it worse
     * than a short honest one.
     */
    const text = composeNotice(ORG, [
      {
        name: { en: 'run the mid-day meal programme' },
        requiresConsent: true,
        fields: [
          { key: 'name', label: { en: 'Name?' } },
          { key: 'age', label: { en: 'Age?' } },
          { key: 'attendance', label: { en: 'Present today?' } },
        ],
      },
    ]);

    expect(text).toContain('We collect Name, Age and Present today, so that we can run the mid-day meal programme.');
    // One bullet for three questions, not three.
    expect(text.split('•')).toHaveLength(2);
  });

  it('names the organisation and how to complain', () => {
    const text = composeNotice(ORG, [
      { name: { en: 'do a thing' }, requiresConsent: true, fields: [{ key: 'a', label: { en: 'A' } }] },
    ]);

    expect(text).toContain('Dharti Foundation is collecting');
    expect(text).toContain('Sunita Devi');
    expect(text).toContain('9876543210');
  });

  it('offers withdrawal only where there is something to withdraw', () => {
    const consented = composeNotice(ORG, [
      { name: { en: 'x' }, requiresConsent: true, fields: [{ key: 'a', label: { en: 'A' } }] },
    ]);
    expect(consented).toContain('change your mind');

    /*
     * Under a Section 7 legitimate use there is nothing to agree to and nothing
     * to take back. Promising a withdrawal the organisation cannot honour is
     * more misleading than saying so plainly.
     */
    const scheme = composeNotice(ORG, [
      { name: { en: 'x' }, requiresConsent: false, fields: [{ key: 'a', label: { en: 'A' } }] },
    ]);
    expect(scheme).not.toContain('change your mind');
    expect(scheme).toContain('does not depend on your agreement');
  });

  it('says what deletion cannot reach', () => {
    // Disclosed rather than discovered. Erasure genuinely cannot recall a
    // spreadsheet already sent to a funder.
    const text = composeNotice(ORG, [
      { name: { en: 'x' }, requiresConsent: true, fields: [{ key: 'a', label: { en: 'A' } }] },
    ]);

    expect(text).toContain('reports we have already given');
    expect(text).toContain('backup');
    expect(text).toContain('without your name');
  });

  it('describes a question as data, not as a question', () => {
    // "we collect: Guardian's phone?" is comic.
    expect(describeField({ key: 'gp', label: { en: "Guardian's phone?" } }, 'en')).toBe(
      "Guardian's phone",
    );
    expect(
      describeField(
        { key: 'gp', label: { en: "Guardian's phone?" }, dataDescription: { en: 'a contact number' } },
        'en',
      ),
    ).toBe('a contact number');
    // Never blank: a gap in the list of what you collect is worse than an
    // awkward word in it.
    expect(describeField({ key: 'q7', label: {} }, 'en')).toBe('q7');
  });
});

describe('hashing what was shown', () => {
  it('ignores only line endings and trailing space', async () => {
    // Anything cleverer and the phone and the server disagree about what "the
    // same text" means, turning every consent into a mismatch.
    const base = await hashNoticeText('We collect your name.\nYou may say no.');
    expect(await hashNoticeText('We collect your name.\r\nYou may say no.')).toBe(base);
    expect(await hashNoticeText('We collect your name.\nYou may say no.  \n')).toBe(base);
    expect(await hashNoticeText('We collect your NAME.\nYou may say no.')).not.toBe(base);
  });
});

describe.skipIf(!hasDatabase)('purposes and notices', () => {
  let org: TestOrg;
  let mealsId: string;
  let schemeId: string;
  let noticeId: string;

  beforeAll(async () => {
    org = await createTestOrg('notices');

    await updateOrgIdentity(ownerDb(), org.id, {
      legalName: 'Test Foundation',
      registeredAddress: '1 Road',
      grievanceOfficerName: 'Officer',
      grievanceOfficerPhone: '9000000000',
    });

    mealsId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'run the mid-day meal programme' },
      lawfulBasis: 'consent',
      retentionMonths: 36,
    });
    schemeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'deliver the scholarship scheme' },
      lawfulBasis: 'state_benefit',
      retentionStatute: 'Income-tax Act, 1961',
    });

    const form = await publishForm(org, 'intake', [
      { key: 'child_name', dataType: 'short_text' },
      { key: 'attendance', dataType: 'boolean' },
      { key: 'unclaimed', dataType: 'short_text' },
    ]);

    // Attribute two of the three questions; the third is the gap the report
    // exists to surface.
    await ownerDb()
      .update(formFields)
      .set({ purposeId: mealsId })
      .where(
        sql`${formFields.formVersionId} = ${form.versionId} AND ${formFields.key} IN ('child_name','attendance')`,
      );

    noticeId = await createNotice(ownerDb(), org.id, { name: { en: 'Beneficiary notice' } });
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('derives an immutable code from the name', async () => {
    const all = await listPurposes(ownerDb(), org.id);
    const meals = all.find((purpose) => purpose.id === mealsId);

    expect(meals?.code).toBe('run_the_mid_day_meal_programme');
    // Same contract as `forms.slug` and `options.code`: it names an analytics
    // column, so it cannot be re-derived from a reworded name.
    expect(Object.keys(meals ?? {})).not.toContain('setCode');
  });

  it('knows which basis needs asking and which does not', () => {
    expect(REQUIRES_CONSENT.consent).toBe(true);
    expect(REQUIRES_CONSENT.guardian_consent).toBe(true);
    // A government scheme is delivered under Section 7(b); asking for consent
    // you do not need implies a withdrawal you cannot honour.
    expect(REQUIRES_CONSENT.state_benefit).toBe(false);
    expect(REQUIRES_CONSENT.employment).toBe(false);
  });

  it('reports what each purpose collects', async () => {
    const coverage = await purposeCoverage(ownerDb(), org.id);
    const meals = coverage.find((entry) => entry.purposeId === mealsId);

    expect(meals?.fields.map((field) => field.key).sort()).toEqual(['attendance', 'child_name']);
  });

  it('names the questions no purpose accounts for', async () => {
    // The check that stops a notice going quietly out of date as forms grow.
    const gaps = await unattributedFields(ownerDb(), org.id);
    expect(gaps.map((gap) => gap.key)).toEqual(['unclaimed']);
  });

  it('writes a first draft from the forms that already exist', async () => {
    const versionId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    const result = await generateNoticeDraft(ownerDb(), org.id, versionId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain('Test Foundation');
    expect(result.text).toContain('run the mid-day meal programme');
    // Only what a purpose claims. An unattributed question is reported, not
    // silently described as belonging to a purpose nobody chose.
    expect(result.text).not.toContain('unclaimed');
  });

  it('will not overwrite words somebody wrote', async () => {
    const versionId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    await updateNoticeDraft(ownerDb(), versionId, { body: { en: 'Our own careful wording.' } });

    const again = await generateNoticeDraft(ownerDb(), org.id, versionId);
    expect(again.ok && again.text).toBe('Our own careful wording.');

    // Unless asked, which is a different button.
    const forced = await generateNoticeDraft(ownerDb(), org.id, versionId, { force: true });
    expect(forced.ok && forced.text).toContain('Test Foundation');
  });

  it('throws away a notice nobody has been read', async () => {
    // `slug` comes from the name and is immutable, so a first attempt with the
    // wrong name is only fixable by discarding it. Safe while unpublished: no
    // consent record can cite a version that was never shown to anyone.
    const scratch = await createNotice(ownerDb(), org.id, { name: { en: 'Draft I typed wrong' } });
    expect(await discardNotice(ownerDb(), org.id, scratch)).toEqual({ ok: true });
    expect((await listNotices(ownerDb(), org.id)).map((n) => n.id)).not.toContain(scratch);
  });

  it('will not throw away a notice that has been published', async () => {
    /*
     * The published version is the organisation's evidence of what somebody was
     * told before they agreed — `consent_events` cites it by id and hash. Losing
     * it would destroy their own defence, so this refuses rather than obliges.
     */
    const keep = await createNotice(ownerDb(), org.id, { name: { en: 'Published notice' } });
    const versionId = await getOrCreateNoticeDraft(ownerDb(), keep, org.adminId);
    await updateNoticeDraft(ownerDb(), versionId, { body: { en: 'We collect your name.' } });
    await setNoticePurposes(ownerDb(), versionId, [mealsId]);
    expect((await publishNotice(ownerDb(), org.id, keep, org.adminId)).ok).toBe(true);

    expect(await discardNotice(ownerDb(), org.id, keep)).toEqual({
      ok: false,
      reason: 'published',
    });
    expect((await listNotices(ownerDb(), org.id)).map((n) => n.id)).toContain(keep);
  });

  it('refuses to publish a notice covering nothing', async () => {
    const versionId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    await setNoticePurposes(ownerDb(), versionId, []);

    // A consent event points at a purpose. There would be none to point at.
    expect(await publishNotice(ownerDb(), org.id, noticeId, org.adminId)).toMatchObject({
      ok: false,
      reason: 'no_purposes',
    });
  });

  it('publishes, freezing the words and hashing them', async () => {
    const versionId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    await setNoticePurposes(ownerDb(), versionId, [mealsId, schemeId]);

    const published = await publishNotice(ownerDb(), org.id, noticeId, org.adminId);
    expect(published.ok).toBe(true);

    const live = await currentNotice(ownerDb(), org.id, 'beneficiary_notice');
    expect(live?.purposeIds.sort()).toEqual([mealsId, schemeId].sort());

    // The hash is the server's answer to "what did this version say", which is
    // what a phone's claim gets checked against.
    expect(live?.bodySha256.en).toBe(await hashNoticeText(live!.body.en!));
  });

  it('cannot be edited once published', async () => {
    const live = await currentNotice(ownerDb(), org.id, 'beneficiary_notice');

    /*
     * The load-bearing assertion. Editing a published notice retroactively
     * changes what everyone who ever consented was told — silently, with
     * nothing looking wrong.
     */
    await expect(
      ownerDb()
        .update(consentNoticeVersions)
        .set({ body: { en: 'Quietly different words.' } })
        .where(eq(consentNoticeVersions.id, live!.versionId)),
    ).rejects.toThrow(/cannot be edited/i);

    await expect(
      ownerDb()
        .delete(consentNoticeVersions)
        .where(eq(consentNoticeVersions.id, live!.versionId)),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('editing makes a new version and leaves the live one alone', async () => {
    const live = await currentNotice(ownerDb(), org.id, 'beneficiary_notice');

    const draftId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    expect(draftId).not.toBe(live!.versionId);

    await updateNoticeDraft(ownerDb(), draftId, { body: { en: 'Second thoughts.' } });

    // A worker reading the notice aloud mid-edit gets the published words, not
    // a half-finished sentence.
    const stillLive = await currentNotice(ownerDb(), org.id, 'beneficiary_notice');
    expect(stillLive?.versionId).toBe(live!.versionId);
    expect(stillLive?.body.en).not.toBe('Second thoughts.');

    // And the purposes carried forward rather than silently emptying.
    const detail = await getNotice(ownerDb(), org.id, 'beneficiary_notice');
    expect(detail?.draft?.purposeIds.sort()).toEqual([mealsId, schemeId].sort());
  });

  it('can mark a published notice as inadequate without pretending it never existed', async () => {
    const live = await currentNotice(ownerDb(), org.id, 'beneficiary_notice');
    await retractNoticeVersion(ownerDb(), live!.versionId);

    const after = await currentNotice(ownerDb(), org.id, 'beneficiary_notice');
    // Still the live version — consent taken under it is still what happened.
    // What this buys is the ability to target re-consent at those people.
    expect(after?.versionId).toBe(live!.versionId);
    expect(after?.retractedAt).toBeInstanceOf(Date);
  });

  it('refuses to publish before the organisation can be named', async () => {
    const bare = await createTestOrg('notices-bare');
    try {
      const id = await createNotice(ownerDb(), bare.id, { name: { en: 'N' } });
      const versionId = await getOrCreateNoticeDraft(ownerDb(), id, bare.adminId);
      await updateNoticeDraft(ownerDb(), versionId, { body: { en: 'Words.' } });

      // A notice with nobody to complain to removes the first step of the
      // right it is supposed to be explaining.
      const result = await publishNotice(ownerDb(), bare.id, id, bare.adminId);
      expect(result).toMatchObject({ ok: false, reason: 'organisation_incomplete' });
    } finally {
      await dropTestOrg(bare);
    }
  });
});

describe.skipIf(!hasDatabase)('a dangling registry nomination', () => {
  /*
   * `subject_types` points at questions by key — which questions name a person,
   * which spot duplicates, and now which holds a date of birth. Nothing checked
   * that those keys existed.
   *
   * The consequence for the first two was quiet degradation: blank names in
   * search, duplicates stopping being caught. For the third it is worse. A
   * dangling `dateOfBirthField` makes `resolveMinorStatus` return `unknown` for
   * every single person, so **no child is ever recognised as a child** and no
   * guardian is ever asked for — with nothing anywhere saying so.
   */
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('nominations');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('is refused at publish, naming the key and why it matters', async () => {
    const form = await publishForm(org, 'reg', [{ key: 'child_name', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['child_name'],
    });

    // The admin nominates a birth-date question that this form does not have —
    // renamed, archived, or never added.
    await ownerDb()
      .update(subjectTypes)
      .set({ dateOfBirthField: 'date_of_birth' })
      .where(eq(subjectTypes.id, form.subjectTypeId));

    const draftId = await getOrCreateDraft(ownerDb(), form.formId, org.adminId);
    const problems = await validateDraft(ownerDb(), draftId);

    const complaint = problems.find((problem) => problem.fieldKey === 'date_of_birth');
    expect(complaint).toBeDefined();
    expect(complaint?.message).toContain('whether someone is a child');

    // And publishing is actually blocked, not merely warned about.
    await expect(publishDraft(ownerDb(), form.formId, org.adminId)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('passes once the question exists', async () => {
    const form = await publishForm(
      org,
      'reg2',
      [
        { key: 'child_name', dataType: 'short_text' },
        { key: 'date_of_birth', dataType: 'date' },
      ],
      { formType: 'registration', displayNameFields: ['child_name'] },
    );

    await ownerDb()
      .update(subjectTypes)
      .set({ dateOfBirthField: 'date_of_birth', matchFields: ['child_name'] })
      .where(eq(subjectTypes.id, form.subjectTypeId));

    const draftId = await getOrCreateDraft(ownerDb(), form.formId, org.adminId);
    expect(await validateDraft(ownerDb(), draftId)).toEqual([]);
  });
});
