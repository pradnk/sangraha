/**
 * Telling an organisation it is collecting data and asking nobody.
 *
 * The failure this guards against was reported from a real setup: a fresh
 * organisation registered a child and was never once asked for consent, and
 * nothing anywhere said so. `consentRequirementFor` returns null when a form's
 * questions rest on no consent purpose, or when no published notice covers the
 * purposes they do rest on — both legitimate states, and both indistinguishable
 * from "everything is fine" if nobody is told.
 *
 * Two places now tell them: the setup guide, which will not report itself
 * complete without purposes and a published notice, and the publish step, which
 * says what a form will and will not ask before it reaches a single worker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getSetupProgress } from '../admin/provision-organisation';
import {
  createNotice,
  getOrCreateNoticeDraft,
  publishNotice,
  setNoticePurposes,
  updateNoticeDraft,
} from '../queries/consent-notices';
import { createPurpose, updatePurpose } from '../queries/purposes';
import { addField, createForm, getOrCreateDraft, publishDraft } from '../queries/form-builder';
import { updateOrgIdentity } from '../queries/organisation-identity';
import { formFields } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('the consent nudge', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('nudge');
    // The notice cannot be published without these, and they are not what is
    // under test here.
    await updateOrgIdentity(ownerDb(), org.id, {
      legalName: 'Nudge Foundation',
      registeredAddress: '1 Road',
      grievanceOfficerName: 'Officer',
      grievanceOfficerPhone: '9000000000',
    });
  }, 60_000);

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  /** A published form with `count` questions, optionally attributed. */
  async function publishFormWith(
    slug: string,
    purposeId: string | null,
  ): Promise<{ warnings: string[] }> {
    const formId = await createForm(ownerDb(), org.id, {
      slug,
      name: { en: slug },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    await addField(ownerDb(), draft, { label: { en: 'Child name' }, dataType: 'short_text' });
    await addField(ownerDb(), draft, { label: { en: 'Date of birth' }, dataType: 'date' });

    if (purposeId) {
      await ownerDb()
        .update(formFields)
        .set({ purposeId })
        .where(sql`${formFields.formVersionId} = ${draft}`);
    }

    const result = await publishDraft(ownerDb(), formId, org.adminId);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return { warnings: result.warnings };
  }

  it('does not call setup complete before purposes and a notice exist', async () => {
    const progress = await getSetupProgress(ownerDb(), org.id);

    // Before the fix these two did not exist, so a brand new organisation could
    // work through the whole guide and still be asking nobody for anything.
    expect(progress.hasPurposes).toBe(false);
    expect(progress.hasPublishedNotice).toBe(false);
  });

  it('warns that questions belong to no purpose, and that nobody will be asked', async () => {
    const { warnings } = await publishFormWith('unattributed_form', null);

    expect(warnings.some((w) => w.includes('not attributed to a purpose'))).toBe(true);
    expect(warnings.some((w) => w.includes('Nobody will be asked for permission'))).toBe(true);
  });

  it('warns hardest when a form needs consent and no notice covers it', async () => {
    /*
     * The reported case. Questions rest on consent, so there is something to
     * ask — and nothing published to read out, so the capture screen skips the
     * consent step entirely and a child is registered with no guardian ever
     * agreeing.
     */
    const purposeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'run the after-school programme' },
      lawfulBasis: 'consent',
      retentionMonths: 24,
    });

    expect((await getSetupProgress(ownerDb(), org.id)).hasPurposes).toBe(true);
    // A purpose alone is not a notice: there is still nothing to read out.
    expect((await getSetupProgress(ownerDb(), org.id)).hasPublishedNotice).toBe(false);

    const { warnings } = await publishFormWith('needs_consent_form', purposeId);

    const alarm = warnings.find((w) => w.includes('published no notice'));
    expect(alarm).toBeDefined();
    expect(alarm).toContain('including for children');
    // And it must not also claim nobody needs asking — that would be the
    // opposite diagnosis of the same state.
    expect(warnings.some((w) => w.includes('Nobody will be asked'))).toBe(false);
  });

  it('stops warning once a notice covering the purpose is published', async () => {
    const purposeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'send the monthly newsletter' },
      lawfulBasis: 'consent',
      retentionMonths: 12,
    });

    const noticeId = await createNotice(ownerDb(), org.id, { name: { en: 'Beneficiary notice' } });
    const versionId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    await updateNoticeDraft(ownerDb(), versionId, {
      body: { en: 'We collect your name so we can run our programme.' },
    });
    await setNoticePurposes(ownerDb(), versionId, [purposeId]);
    const published = await publishNotice(ownerDb(), org.id, noticeId, org.adminId);
    expect(published.ok, JSON.stringify(published)).toBe(true);

    expect((await getSetupProgress(ownerDb(), org.id)).hasPublishedNotice).toBe(true);

    const { warnings } = await publishFormWith('covered_form', purposeId);
    expect(warnings.some((w) => w.includes('published no notice'))).toBe(false);
    expect(warnings.some((w) => w.includes('not attributed to a purpose'))).toBe(false);
  });

  it('reports how much of each thing there is, not just whether there is any', async () => {
    /*
     * The setup screen stopped being a checklist and became the standing index
     * of how the organisation is configured, so a green tick is no longer
     * enough: an admin deciding whether to add a fourth purpose needs to be
     * told there are three. These are the numbers that page renders.
     */
    const { counts } = await getSetupProgress(ownerDb(), org.id);

    expect(counts.purposes).toBeGreaterThan(0);
    expect(counts.places).toBeGreaterThan(0);
    expect(counts.languages).toBeGreaterThan(0);
    expect(counts.people).toBeGreaterThan(0);
    // Named, not merely present — the row shows who to go and talk to.
    expect(counts.privacyContact).toBe('Officer');
  });

  it('stops counting a notice whose only purpose was switched off', async () => {
    /*
     * The guide reads from live data, so a purpose retired after the notice was
     * published has to take the step back with it — otherwise the checklist
     * claims a notice that `consentRequirementFor` will pass over, and the
     * organisation is back to asking nobody while being told it is done.
     */
    const before = await getSetupProgress(ownerDb(), org.id);
    expect(before.hasPublishedNotice).toBe(true);

    const covered = await ownerDb().execute(sql`
      SELECT np.purpose_id AS id
      FROM consent_notices n
      JOIN consent_notice_versions v ON v.id = n.current_version_id
      JOIN consent_notice_purposes np ON np.notice_version_id = v.id
      WHERE n.org_id = ${org.id}
    `);

    for (const row of covered as unknown as { id: string }[]) {
      await updatePurpose(ownerDb(), org.id, row.id, { isActive: false });
    }

    expect((await getSetupProgress(ownerDb(), org.id)).hasPublishedNotice).toBe(false);
  });
});
