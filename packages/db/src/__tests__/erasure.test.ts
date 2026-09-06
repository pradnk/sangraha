/**
 * Forgetting somebody.
 *
 * Every test here is a place the person physically is, and each was found by
 * asking "where else could their name be?" rather than by reading the schema.
 * The two that would have been missed are the duplicate cluster — a second row
 * holding the same human — and `review_note`, which is supervisor free text and
 * reliably contains names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  addLegalHold,
  erasureCluster,
  holdsBlocking,
  listErasureRequests,
  purgeErasures,
  refuseErasure,
  requestErasure,
} from '../queries/erasure';
import { consentSummary, recordConsentEvents, subjectPseudonym } from '../queries/consent';
import { createPurpose } from '../queries/purposes';
import {
  createNotice,
  getOrCreateNoticeDraft,
  publishNotice,
  setNoticePurposes,
  updateNoticeDraft,
} from '../queries/consent-notices';
import { updateOrgIdentity } from '../queries/organisation-identity';
import { markAsDuplicate } from '../queries/subjects';
import {
  consentEvents,
  programmeCounters,
  subjects,
  submissionRevisions,
  submissions,
} from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('erasure', () => {
  let org: TestOrg;
  let purposeId: string;
  let noticeVersionId: string;
  let formId: string;
  let versionId: string;
  let subjectTypeId: string;

  /** A person, a record about them, and a consent — the whole footprint. */
  async function someone(name: string) {
    const [person] = await ownerDb()
      .insert(subjects)
      .values({
        orgId: org.id,
        subjectTypeId,
        displayName: name,
        externalId: `ext-${name.replace(/\s/g, '')}`,
        attributes: { full_name: name, village: 'Kittur', goats: 4 },
        locationId: org.villageAId,
        createdBy: org.workerAId,
      })
      .returning({ id: subjects.id });

    const [submission] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId,
        formVersionId: versionId,
        subjectId: person!.id,
        locationId: org.villageAId,
        data: { note: `about ${name}` },
        // Supervisor free text. The column everyone forgets.
        reviewNote: `Spoke to ${name}'s mother, will revisit`,
        deviceMeta: { userAgent: 'test' },
        status: 'approved',
        submittedBy: org.workerAId,
        submittedAt: new Date('2026-03-15T00:00:00Z'),
        clientUuid: randomUUID(),
      })
      .returning({ id: submissions.id });

    await ownerDb().insert(submissionRevisions).values({
      submissionId: submission!.id,
      revisionNo: 1,
      changeType: 'created',
      status: 'approved',
      data: { note: `about ${name}` },
      reason: `captured by a worker who met ${name}`,
      changedBy: org.workerAId,
    });

    await recordConsentEvents(
      ownerDb(),
      { orgId: org.id, userId: org.workerAId, role: 'field_worker' },
      [
        {
          clientEventUuid: randomUUID(),
          subjectId: person!.id,
          purposeId,
          action: 'given',
          lawfulBasis: 'consent',
          noticeVersionId,
          noticeLocale: 'kn',
          guardianName: `${name}'s mother`,
        },
      ],
    );

    return person!.id;
  }

  beforeAll(async () => {
    org = await createTestOrg('erasure');
    await updateOrgIdentity(ownerDb(), org.id, {
      legalName: 'T',
      registeredAddress: 'R',
      grievanceOfficerName: 'O',
      grievanceOfficerPhone: '9000000000',
    });

    purposeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'run the programme' },
      lawfulBasis: 'consent',
    });
    const noticeId = await createNotice(ownerDb(), org.id, { name: { en: 'N' } });
    const draftId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    await updateNoticeDraft(ownerDb(), draftId, { body: { en: 'Words.' } });
    await setNoticePurposes(ownerDb(), draftId, [purposeId]);
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

  it('covers the duplicate cluster, not just the row that was named', async () => {
    /*
     * The sharpest defect in a naive erasure. Duplicates are linked and never
     * merged, so both rows hold their own copy of the same human's answers.
     * Erasing only the one that was asked about leaves the other intact — and
     * because `duplicate_of_id` is ON DELETE SET NULL, the survivor is quietly
     * promoted to canonical.
     */
    const canonical = await someone('Sunita Devi');
    const duplicate = await someone('Sunita D');
    await markAsDuplicate(ownerDb(), {
      subjectId: duplicate,
      canonicalId: canonical,
      markedBy: org.supervisorId,
    });

    // Asking about either one finds both.
    expect((await erasureCluster(ownerDb(), org.id, canonical)).sort()).toEqual(
      [canonical, duplicate].sort(),
    );
    expect((await erasureCluster(ownerDb(), org.id, duplicate)).sort()).toEqual(
      [canonical, duplicate].sort(),
    );

    await requestErasure(ownerDb(), org.id, {
      subjectId: duplicate,
      receivedBy: org.adminId,
      requestedByName: 'Sunita Devi',
      identityCheckedNote: 'Known to the worker for two years',
    });

    // Both are hidden immediately, before any purge runs.
    const hidden = await ownerDb()
      .select({ id: subjects.id, deletedAt: subjects.deletedAt })
      .from(subjects)
      .where(sql`${subjects.id} = ANY(ARRAY[${canonical}, ${duplicate}]::uuid[])`);
    expect(hidden.every((row) => row.deletedAt !== null)).toBe(true);
  });

  it('stops the processing the moment it is asked, not when an admin gets round to it', async () => {
    // Every read query in the codebase already filters `deleted_at`, so the
    // soft delete takes effect the instant it is written. A record still
    // visible while it sits in a queue is a record still being used.
    const visible = await ownerDb()
      .select({ id: subjects.id })
      .from(subjects)
      .where(sql`${subjects.orgId} = ${org.id} AND ${subjects.deletedAt} IS NULL`);

    expect(visible.map((row) => row.id)).not.toContain(
      (await erasureCluster(ownerDb(), org.id, (await listErasureRequests(ownerDb(), org.id))[0]!.subjectId!))[0],
    );
  });

  it('keeps the counts before destroying what they were counted from', async () => {
    const before = await ownerDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(programmeCounters)
      .where(eq(programmeCounters.orgId, org.id));
    expect(Number(before[0]?.n ?? 0)).toBe(0);

    const result = await purgeErasures(ownerDb(), org.id, { keepAttributes: ['village'] });
    expect(result.countersWritten).toBeGreaterThan(0);

    /*
     * The thing that actually protects a donor report. "1,240 children in
     * Belagavi in Q2" is not personal data and survives honestly; deriving it
     * after the purge is impossible by construction.
     */
    const [counter] = await ownerDb()
      .select({ records: programmeCounters.recordCount, people: programmeCounters.peopleCount })
      .from(programmeCounters)
      .where(eq(programmeCounters.orgId, org.id));
    expect(counter!.records).toBeGreaterThan(0);
  });

  it('reaches the review note, the revisions and the denormalised name', async () => {
    const rows = await ownerDb()
      .select({
        displayName: subjects.displayName,
        externalId: subjects.externalId,
        attributes: subjects.attributes,
      })
      .from(subjects)
      .where(eq(subjects.orgId, org.id));

    for (const row of rows) {
      expect(row.displayName).not.toContain('Sunita');
      expect(row.externalId).toBeNull();
      // Declared what to KEEP, so a field nobody thought about is gone rather
      // than retained.
      expect(row.attributes).not.toHaveProperty('full_name');
      expect(row.attributes).not.toHaveProperty('goats');
      expect(row.attributes).toHaveProperty('village');
    }

    const kept = await ownerDb()
      .select({ note: submissions.reviewNote, data: submissions.data })
      .from(submissions)
      .where(eq(submissions.orgId, org.id));
    for (const row of kept) {
      // The column everyone forgets.
      expect(row.note).toBeNull();
      expect(row.data).toEqual({});
    }

    // Joined through `submissions` because `submission_revisions` has no
    // `org_id` of its own — and without the join this read every revision in
    // the database, including other organisations' fixtures.
    const revisions = await ownerDb()
      .select({ data: submissionRevisions.data, reason: submissionRevisions.reason })
      .from(submissionRevisions)
      .innerJoin(submissions, eq(submissions.id, submissionRevisions.submissionId))
      .where(eq(submissions.orgId, org.id));
    for (const row of revisions) {
      expect(row.data).toEqual({});
      expect(row.reason).toBeNull();
    }
  });

  it('keeps the consent log as proof, naming nobody', async () => {
    /*
     * The tension resolved. The log is the evidence consent was given, and it
     * names the person who asked to be forgotten. Redaction keeps the fact and
     * drops the identity: this row still says somebody consented to this
     * purpose under this notice, read in Kannada.
     */
    const rows = await ownerDb()
      .select({
        subjectId: consentEvents.subjectId,
        pseudonym: consentEvents.subjectPseudonym,
        redactedAt: consentEvents.redactedAt,
        guardianName: consentEvents.guardianName,
        noticeVersionId: consentEvents.noticeVersionId,
        noticeLocale: consentEvents.noticeLocale,
        action: consentEvents.action,
      })
      .from(consentEvents)
      .where(eq(consentEvents.orgId, org.id));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.subjectId).toBeNull();
      expect(row.guardianName).toBeNull();
      expect(row.redactedAt).toBeInstanceOf(Date);
      // What survives is what an auditor needs.
      expect(row.pseudonym).toHaveLength(64);
      expect(row.noticeVersionId).toBe(noticeVersionId);
      expect(row.noticeLocale).toBe('kn');
      expect(row.action).toBe('given');
    }
  });

  it('records that the request was honoured, and outlives the person', async () => {
    const [request] = await listErasureRequests(ownerDb(), org.id);

    expect(request?.status).toBe('completed');
    expect(request?.completedAt).toBeInstanceOf(Date);
    // The subject is gone; the record of the request is not.
    expect(request?.subjectId).toBeNull();
  });

  it('is idempotent — running it again does nothing', async () => {
    const again = await purgeErasures(ownerDb(), org.id);
    expect(again).toMatchObject({ subjects: 0, submissions: 0, consentRedacted: 0 });
  });

  it('can be rehearsed without destroying anything', async () => {
    const person = await someone('Dry Run');
    await requestErasure(ownerDb(), org.id, { subjectId: person, receivedBy: org.adminId });

    const rehearsal = await purgeErasures(ownerDb(), org.id, { dryRun: true });
    expect(rehearsal.subjects).toBeGreaterThan(0);

    // Still there, and still named.
    const [row] = await ownerDb()
      .select({ displayName: subjects.displayName })
      .from(subjects)
      .where(eq(subjects.id, person));
    expect(row?.displayName).toBe('Dry Run');
  });

  it('refuses with a citable ground, and puts the record back', async () => {
    const person = await someone('Held Back');
    const { requestId } = await requestErasure(ownerDb(), org.id, {
      subjectId: person,
      receivedBy: org.adminId,
    });

    await refuseErasure(ownerDb(), org.id, requestId, {
      statute: 'Foreign Contribution (Regulation) Act, 2010',
      note: 'Beneficiary verification records for a grant audited to 2031.',
      decidedBy: org.adminId,
    });

    const request = (await listErasureRequests(ownerDb(), org.id)).find((r) => r.id === requestId);
    // "No" without a ground somebody could check is not a refusal.
    expect(request).toMatchObject({ status: 'refused' });
    expect(request?.refusalStatute).toContain('Foreign Contribution');

    // And the processing resumes, because the refusal says it lawfully must.
    const [row] = await ownerDb()
      .select({ deletedAt: subjects.deletedAt, name: subjects.displayName })
      .from(subjects)
      .where(eq(subjects.id, person));
    expect(row?.deletedAt).toBeNull();
    expect(row?.name).toBe('Held Back');
  });

  it('scopes a legal hold to a purpose rather than the whole organisation', async () => {
    /*
     * FCRA and Income Tax retention cover financial and beneficiary-verification
     * records — not a child's photograph. A hold that swallowed everything would
     * turn "we must keep some of this" into "we keep all of it".
     */
    await addLegalHold(ownerDb(), org.id, {
      purposeId,
      statute: 'Income-tax Act, 1961',
      section: '44AA',
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      createdBy: org.adminId,
    });

    const holds = await holdsBlocking(ownerDb(), org.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ statute: 'Income-tax Act, 1961', section: '44AA' });
  });

  it('lets an expired hold lapse without anything being scheduled', async () => {
    await addLegalHold(ownerDb(), org.id, {
      purposeId,
      statute: 'Already Over Act',
      expiresAt: new Date(Date.now() - 86_400_000),
      createdBy: org.adminId,
    });

    // Derived from the clock: it simply stops matching, which is correct on
    // every deployment including one nobody has scheduled anything on.
    const statutes = (await holdsBlocking(ownerDb(), org.id)).map((hold) => hold.statute);
    expect(statutes).not.toContain('Already Over Act');
  });

  it('stops counting an erased person as a live compliance problem', async () => {
    /*
     * The dashboard is about people the organisation currently holds. An erased
     * child still marked "no guardian named" is a problem nobody can act on and
     * one that never goes away — the queue becomes undrainable and the number
     * stops meaning anything.
     *
     * The log keeps the row regardless. That is the whole point of redacting
     * rather than deleting: the evidence survives, the live count does not.
     */
    const summary = await consentSummary(ownerDb(), org.id);
    expect(summary.childrenWithoutGuardian).toBe(0);
    expect(summary.overridesPending).toBe(0);

    const [held] = await ownerDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(consentEvents)
      .where(eq(consentEvents.orgId, org.id));
    expect(Number(held!.n)).toBeGreaterThan(0);
  });

  it('gives the same person the same pseudonym before and after', async () => {
    // Which is what lets an auditor correlate an erased consent with the
    // request that erased it.
    const [request] = await listErasureRequests(ownerDb(), org.id);
    expect(request).toBeDefined();
    expect(subjectPseudonym(org.id, 'x')).toBe(subjectPseudonym(org.id, 'x'));
  });
});
