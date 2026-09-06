/**
 * The two duties that pull against each other, and what happens where they meet.
 *
 * A person asks to be forgotten. A statute says some of what they are asking
 * about has to be kept. Both are legal obligations and the system used to
 * honour only one of them: `holdsBlocking` was consulted when the request was
 * filed, shown to the admin once, and then the purge destroyed everything
 * anyway.
 *
 * Kept in its own file rather than added to `erasure.test.ts`, because that
 * suite is deliberately sequential — one organisation, purged partway through —
 * and a hold introduced into the middle of it would change what every later
 * test is looking at.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  addLegalHold,
  listErasureRequests,
  purgeErasures,
  requestErasure,
} from '../queries/erasure';
import { recordConsentEvents } from '../queries/consent';
import { createPurpose } from '../queries/purposes';
import {
  createNotice,
  getOrCreateNoticeDraft,
  publishNotice,
  setNoticePurposes,
  updateNoticeDraft,
} from '../queries/consent-notices';
import { updateOrgIdentity } from '../queries/organisation-identity';
import { formFields, legalHolds, subjects, submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('erasure under a legal hold', () => {
  let org: TestOrg;
  /** What the records are collected for, and what the hold will name. */
  let heldPurposeId: string;
  /** A second purpose nothing is held under, to prove the scoping. */
  let freePurposeId: string;
  let noticeVersionId: string;
  let formId: string;
  let versionId: string;
  let subjectTypeId: string;

  /**
   * A person, a record about them, and a consent naming one purpose.
   *
   * `consented` is what links them to a purpose, which is what a hold is
   * scoped by. Passing null makes somebody whose records exist with no consent
   * on file at all — a legitimate-use record, which the purpose attribution on
   * the question itself has to cover instead.
   */
  async function someone(name: string, consented: string | null) {
    const [person] = await ownerDb()
      .insert(subjects)
      .values({
        orgId: org.id,
        subjectTypeId,
        displayName: name,
        attributes: { full_name: name, village: 'Kittur' },
        locationId: org.villageAId,
        createdBy: org.workerAId,
      })
      .returning({ id: subjects.id });

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: versionId,
      subjectId: person!.id,
      locationId: org.villageAId,
      data: { note: `about ${name}` },
      status: 'approved',
      submittedBy: org.workerAId,
      submittedAt: new Date('2026-03-15T00:00:00Z'),
      clientUuid: randomUUID(),
    });

    if (consented) {
      await recordConsentEvents(
        ownerDb(),
        { orgId: org.id, userId: org.workerAId, role: 'field_worker' },
        [
          {
            clientEventUuid: randomUUID(),
            subjectId: person!.id,
            purposeId: consented,
            action: 'given',
            lawfulBasis: 'consent',
            noticeVersionId,
            noticeLocale: 'kn',
          },
        ],
      );
    }

    return person!.id;
  }

  /** Files the request the way the Privacy screen does, names and all. */
  const askToBeForgotten = (subjectId: string) =>
    requestErasure(ownerDb(), org.id, {
      subjectId,
      mode: 'pseudonymise',
      requestedByName: 'Lakshmi Devi',
      requestedByRelationship: 'mother',
      identityCheckedNote: 'Known to the worker; visited Lakshmi Devi for two years',
      receivedBy: org.adminId,
    });

  const nameOf = async (subjectId: string): Promise<string | null> => {
    const [row] = await ownerDb()
      .select({ name: subjects.displayName })
      .from(subjects)
      .where(eq(subjects.id, subjectId));
    return row?.name ?? null;
  };

  beforeAll(async () => {
    org = await createTestOrg('erasureholds');
    await updateOrgIdentity(ownerDb(), org.id, {
      legalName: 'T',
      registeredAddress: 'R',
      grievanceOfficerName: 'O',
      grievanceOfficerPhone: '9000000000',
    });

    heldPurposeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'account for the grant' },
      lawfulBasis: 'consent',
    });
    freePurposeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'run the programme' },
      lawfulBasis: 'consent',
    });

    const noticeId = await createNotice(ownerDb(), org.id, { name: { en: 'N' } });
    const draftId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    await updateNoticeDraft(ownerDb(), draftId, { body: { en: 'Words.' } });
    await setNoticePurposes(ownerDb(), draftId, [heldPurposeId, freePurposeId]);
    const published = await publishNotice(ownerDb(), org.id, noticeId, org.adminId);
    if (!published.ok) throw new Error('notice did not publish');
    noticeVersionId = published.versionId;

    const form = await publishForm(org, 'visits', [{ key: 'note', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['note'],
    });
    formId = form.formId;
    versionId = form.versionId;
    subjectTypeId = form.subjectTypeId;
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('does not destroy records a live statute still covers', async () => {
    const person = await someone('Held Person', heldPurposeId);
    await askToBeForgotten(person);

    await addLegalHold(ownerDb(), org.id, {
      purposeId: heldPurposeId,
      statute: 'Income-tax Act, 1961',
      section: '44AA',
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      createdBy: org.adminId,
    });

    const result = await purgeErasures(ownerDb(), org.id, { keepAttributes: ['village'] });

    expect(result.heldBack).toHaveLength(1);
    expect(result.heldBack[0]!.holds[0]).toMatchObject({
      statute: 'Income-tax Act, 1961',
      section: '44AA',
    });
    // Nothing was touched. The records the statute requires are still there.
    expect(result.subjects).toBe(0);
    expect(await nameOf(person)).toBe('Held Person');
  });

  it('leaves the request open so it completes on its own once the hold lifts', async () => {
    // The soft delete from `requestErasure` stands throughout, so the person is
    // not being processed in the meantime — only retained.
    const [request] = await listErasureRequests(ownerDb(), org.id);
    expect(request!.status).toBe('accepted');

    const [hidden] = await ownerDb()
      .select({ deletedAt: subjects.deletedAt })
      .from(subjects)
      .where(eq(subjects.displayName, 'Held Person'));
    expect(hidden!.deletedAt).not.toBeNull();
  });

  it('reports a dry run as held back rather than as work it would do', async () => {
    // A rehearsal that promised to erase somebody it would in fact skip would
    // be worse than no rehearsal.
    const rehearsal = await purgeErasures(ownerDb(), org.id, { dryRun: true });

    expect(rehearsal.heldBack).toHaveLength(1);
    expect(rehearsal.subjects).toBe(0);
  });

  it('never reaches object storage while the hold stands', async () => {
    /*
     * The photographs are deleted before the transaction opens, because object
     * storage cannot join one — so a hold checked any later than this would
     * find the bytes already gone and nothing to roll back.
     */
    let asked = 0;
    await purgeErasures(ownerDb(), org.id, {
      deleteObject: async () => {
        asked += 1;
        return true;
      },
    });

    expect(asked).toBe(0);
  });

  it('leaves alone a person the held purpose does not touch', async () => {
    /*
     * The scoping the schema comment on `legal_holds` insists on: a hold covers
     * the purpose it names, not the organisation. Someone whose records are
     * collected for something else is erased on time.
     */
    const person = await someone('Unheld Person', freePurposeId);
    await askToBeForgotten(person);

    const result = await purgeErasures(ownerDb(), org.id, { keepAttributes: ['village'] });

    expect(result.subjects).toBeGreaterThan(0);
    expect(await nameOf(person)).toBe("Erased at this person's request");
    // And the held one is still held.
    expect(result.heldBack).toHaveLength(1);
    expect(await nameOf((await ownerDb()
      .select({ id: subjects.id })
      .from(subjects)
      .where(eq(subjects.displayName, 'Held Person')))[0]!.id)).toBe('Held Person');
  });

  it('leaves no name behind on a request it did complete', async () => {
    /*
     * The last place the person is. `subject_name_at_request` is documented in
     * the schema as kept "until completion" and was never cleared, so after an
     * erasure reported as completed their full name — and the requester's, and
     * the identity-check note, which is free text and reliably contains
     * names — were still rendered on the organisation's own privacy screen.
     */
    const rows = await listErasureRequests(ownerDb(), org.id);
    const completed = rows.filter((row) => row.status === 'completed');
    expect(completed.length).toBeGreaterThan(0);

    for (const row of completed) {
      expect(row.subjectId).toBeNull();
      expect(row.subjectNameAtRequest).toBeNull();
    }

    // Not exposed by `listErasureRequests`, so checked at the source.
    const raw = (await ownerDb().execute(sql`
      SELECT requested_by_name, requested_by_relationship, identity_checked_note,
             subject_pseudonym, completed_at
      FROM erasure_requests
      WHERE org_id = ${org.id} AND status = 'completed'
    `)) as unknown as Record<string, unknown>[];

    expect(raw.length).toBeGreaterThan(0);
    for (const row of raw) {
      expect(row.requested_by_name).toBeNull();
      expect(row.requested_by_relationship).toBeNull();
      expect(row.identity_checked_note).toBeNull();
      // What has to survive: the proof, without the person.
      expect(row.subject_pseudonym).toBeTruthy();
      expect(row.completed_at).not.toBeNull();
    }
  });

  it('keeps the name while the request is still open', async () => {
    // The admin deciding on a request has to be able to see who it is about.
    // Redaction belongs at completion, not at filing.
    const [open] = (await ownerDb().execute(sql`
      SELECT subject_name_at_request, requested_by_name
      FROM erasure_requests
      WHERE org_id = ${org.id} AND status = 'accepted'
    `)) as unknown as Record<string, unknown>[];

    expect(open!.subject_name_at_request).toBe('Held Person');
    expect(open!.requested_by_name).toBe('Lakshmi Devi');
  });

  it('completes the held request once the hold has expired', async () => {
    // Derived from the clock, so nothing has to be scheduled: the hold simply
    // stops matching and the next run picks the request up.
    await ownerDb().execute(sql`
      UPDATE legal_holds SET expires_at = now() - interval '1 day'
      WHERE org_id = ${org.id}
    `);

    const result = await purgeErasures(ownerDb(), org.id, { keepAttributes: ['village'] });

    expect(result.heldBack).toHaveLength(0);
    expect(result.subjects).toBeGreaterThan(0);
    expect(await nameOf((await ownerDb()
      .select({ id: subjects.id })
      .from(subjects)
      .where(eq(subjects.displayName, "Erased at this person's request")))[0]!.id))
      .toBe("Erased at this person's request");
  });

  it('holds a record attributed to a purpose nobody was asked about', async () => {
    /*
     * A legitimate use under Section 7 collects without asking, so there is no
     * consent event to scope by — the attribution lives on the question. A hold
     * that only looked at consent would destroy exactly the financial records
     * these holds exist for.
     */
    await ownerDb()
      .update(formFields)
      .set({ purposeId: heldPurposeId })
      .where(eq(formFields.formVersionId, versionId));

    await ownerDb().insert(legalHolds).values({
      orgId: org.id,
      purposeId: heldPurposeId,
      statute: 'FCRA, 2010',
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      createdBy: org.adminId,
    });

    const person = await someone('Never Asked', null);
    await askToBeForgotten(person);

    const result = await purgeErasures(ownerDb(), org.id, { keepAttributes: ['village'] });

    expect(result.heldBack.some((entry) => entry.holds.some((h) => h.statute === 'FCRA, 2010')))
      .toBe(true);
    expect(await nameOf(person)).toBe('Never Asked');
  });
});
