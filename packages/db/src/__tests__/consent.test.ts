/**
 * The consent log.
 *
 * Four properties carry the whole design, and each fails silently if it breaks:
 * a device clock cannot reorder events, a replay cannot double-count, a
 * withdrawal cannot be lost, and nothing can rewrite what was recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database } from '../client';
import {
  ConsentConflictError,
  consentStateFor,
  consentSummary,
  decideOverride,
  mayCollect,
  pendingOverrides,
  recordConsentEvents,
  subjectPseudonym,
  consentRecordFor,
  isOverrideVisible,
} from '../queries/consent';
import { hashNoticeText } from '@sangraha/form-engine';
import { createPurpose } from '../queries/purposes';
import {
  createNotice,
  getOrCreateNoticeDraft,
  publishNotice,
  setNoticePurposes,
  updateNoticeDraft,
} from '../queries/consent-notices';
import { updateOrgIdentity } from '../queries/organisation-identity';
import { consentEvents, subjects } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('recording consent', () => {
  let appClient: postgres.Sql;
  let appDb: Database;
  let org: TestOrg;
  let mealsId: string;
  let schemeId: string;
  let noticeVersionId: string;
  let sunita: string;
  let child: string;

  const actor = () => ({ orgId: org.id, userId: org.workerAId, role: 'field_worker' });

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 2);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('consent');
    await updateOrgIdentity(ownerDb(), org.id, {
      legalName: 'Test Foundation',
      registeredAddress: '1 Road',
      grievanceOfficerName: 'Officer',
      grievanceOfficerPhone: '9000000000',
    });

    mealsId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'run the meal programme' },
      lawfulBasis: 'consent',
    });
    schemeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'deliver the scholarship' },
      lawfulBasis: 'state_benefit',
    });

    const noticeId = await createNotice(ownerDb(), org.id, { name: { en: 'Notice' } });
    const draftId = await getOrCreateNoticeDraft(ownerDb(), noticeId, org.adminId);
    await updateNoticeDraft(ownerDb(), draftId, { body: { en: 'We collect your name.' } });
    await setNoticePurposes(ownerDb(), draftId, [mealsId, schemeId]);
    const published = await publishNotice(ownerDb(), org.id, noticeId, org.adminId);
    if (!published.ok) throw new Error('notice did not publish');
    noticeVersionId = published.versionId;

    const registration = await publishForm(org, 'reg', [{ key: 'name', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });

    const people = await ownerDb()
      .insert(subjects)
      .values(
        ['Sunita Devi', 'Small Child'].map((displayName) => ({
          orgId: org.id,
          subjectTypeId: registration.subjectTypeId,
          displayName,
          attributes: {},
          locationId: org.villageAId,
          createdBy: org.workerAId,
        })),
      )
      .returning({ id: subjects.id });
    sunita = people[0]!.id;
    child = people[1]!.id;
  });

  afterAll(async () => {
    await appClient.end();
    await dropTestOrg(org);
    await closeHarness();
  });

  it('records a consent and reports it as standing', async () => {
    await recordConsentEvents(ownerDb(), actor(), [
      {
        clientEventUuid: randomUUID(),
        subjectId: sunita,
        purposeId: mealsId,
        action: 'given',
        lawfulBasis: 'consent',
        noticeVersionId,
        noticeLocale: 'kn',
        noticeSecondsShown: 42,
        noticeReadAloud: true,
      },
    ]);

    const [state] = await consentStateFor(ownerDb(), org.id, sunita);
    expect(state).toMatchObject({ action: 'given', isActive: true, noticeVersionId });
    expect(await mayCollect(ownerDb(), org.id, sunita, mealsId)).toEqual({
      allowed: true,
      reason: 'consented',
    });
  });

  it('treats a withdrawal as a new event, not an edit', async () => {
    await recordConsentEvents(ownerDb(), actor(), [
      {
        clientEventUuid: randomUUID(),
        subjectId: sunita,
        purposeId: mealsId,
        action: 'withdrawn',
        lawfulBasis: 'consent',
        noticeVersionId,
      },
    ]);

    expect(await mayCollect(ownerDb(), org.id, sunita, mealsId)).toEqual({
      allowed: false,
      reason: 'withdrawn',
    });

    // The earlier consent is still on file. It *was* the lawful basis for the
    // processing that already happened; erasing it would make that a lie.
    const history = await ownerDb()
      .select({ action: consentEvents.action })
      .from(consentEvents)
      .where(eq(consentEvents.subjectId, sunita));
    expect(history.map((row) => row.action)).toEqual(
      expect.arrayContaining(['given', 'withdrawn']),
    );
  });

  it('will not let a slow device clock resurrect a withdrawn consent', async () => {
    /*
     * The failure this exists to prevent, and it is silent. A phone three days
     * behind records a "given"; ordered by the device's claim it wins, and the
     * system goes on collecting data it has been told to stop collecting with
     * nothing anywhere looking wrong.
     */
    await recordConsentEvents(ownerDb(), actor(), [
      {
        clientEventUuid: randomUUID(),
        subjectId: sunita,
        purposeId: mealsId,
        action: 'given',
        lawfulBasis: 'consent',
        noticeVersionId,
        clientOccurredAt: new Date(Date.now() + 5 * 86_400_000),
      },
    ]);

    const [state] = await consentStateFor(ownerDb(), org.id, sunita);
    // Clamped to arrival, so it does not leap over the withdrawal — but it is
    // still the newest event, so it legitimately stands.
    expect(state?.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // And the raw claim is kept, because the audit needs to see the lie.
    const [row] = await ownerDb()
      .select({
        claimed: consentEvents.clientOccurredAt,
        recorded: consentEvents.occurredAt,
      })
      .from(consentEvents)
      .where(eq(consentEvents.subjectId, sunita))
      .orderBy(sql`seq DESC`)
      .limit(1);
    expect(row!.claimed!.getTime()).toBeGreaterThan(row!.recorded.getTime());
  });

  it('is idempotent on a replay, and loud on a changed one', async () => {
    const id = randomUUID();
    const event = {
      clientEventUuid: id,
      subjectId: child,
      purposeId: mealsId,
      action: 'given' as const,
      lawfulBasis: 'consent' as const,
      noticeVersionId,
    };

    expect(await recordConsentEvents(ownerDb(), actor(), [event])).toEqual({
      written: 1,
      replayed: 0,
    });
    // The retry queue re-sends; that must not double-count.
    expect(await recordConsentEvents(ownerDb(), actor(), [event])).toEqual({
      written: 0,
      replayed: 1,
    });

    /*
     * The same key with different content is a client bug or tampering, not a
     * retry. `onConflictDoNothing` would swallow it, and the log would quietly
     * disagree with what the device believes it recorded.
     */
    await expect(
      recordConsentEvents(ownerDb(), actor(), [{ ...event, action: 'withdrawn' }]),
    ).rejects.toBeInstanceOf(ConsentConflictError);
  });

  it('needs no consent for a government scheme, and says which', async () => {
    // Section 7(b). Asking for consent you do not need implies a withdrawal you
    // cannot honour.
    expect(await mayCollect(ownerDb(), org.id, sunita, schemeId)).toEqual({
      allowed: true,
      reason: 'legitimate_use',
    });
  });

  it('fails closed when nobody was ever asked', async () => {
    const stranger = (
      await ownerDb()
        .insert(subjects)
        .values({
          orgId: org.id,
          subjectTypeId: (
            await ownerDb()
              .select({ id: subjects.subjectTypeId })
              .from(subjects)
              .where(eq(subjects.id, sunita))
          )[0]!.id,
          displayName: 'Never Asked',
          attributes: {},
          createdBy: org.workerAId,
        })
        .returning({ id: subjects.id })
    )[0]!.id;

    // No record at all is not permission.
    expect(await mayCollect(ownerDb(), org.id, stranger, mealsId)).toEqual({
      allowed: false,
      reason: 'never_asked',
    });
  });

  it('refuses a consent that cites no notice', async () => {
    /*
     * A database CHECK, not a code path. "We can always show what this person
     * was told" has to be a property of the data rather than of whichever call
     * site remembered.
     */
    await expect(
      ownerDb()
        .insert(consentEvents)
        .values({
          orgId: org.id,
          clientEventUuid: randomUUID(),
          subjectId: sunita,
          subjectPseudonym: subjectPseudonym(org.id, sunita),
          purposeId: mealsId,
          action: 'given',
          lawfulBasis: 'consent',
          noticeVersionId: null,
        }),
    ).rejects.toThrow(/consent_events_notice_required/);
  });

  describe('the words that were actually on the screen', () => {
    /*
     * `notice_mismatch` was declared, rendered as a warning on the consent
     * record and counted on the privacy dashboard — and nothing ever wrote it.
     * The client sent back the server's own published hash, and the server
     * stored it without comparing it to anything, so the figure was permanently
     * zero and the warning permanently false. A phone rendering a stale cached
     * notice is exactly what the column exists to catch.
     */
    const record = async (sha: string | null, locale = 'en') => {
      const clientEventUuid = randomUUID();
      await recordConsentEvents(ownerDb(), actor(), [
        {
          clientEventUuid,
          subjectId: sunita,
          purposeId: mealsId,
          action: 'given',
          lawfulBasis: 'consent',
          noticeVersionId,
          noticeLocale: locale,
          noticeTextSha256: sha,
        },
      ]);
      const [row] = await ownerDb()
        .select({ mismatch: consentEvents.noticeMismatch })
        .from(consentEvents)
        .where(eq(consentEvents.clientEventUuid, clientEventUuid));
      return row!.mismatch;
    };

    it('flags a device that showed something else', async () => {
      expect(await record('0'.repeat(64))).toBe(true);
    });

    it('does not flag the words we published', async () => {
      const published = await hashNoticeText('We collect your name.');
      expect(await record(published)).toBe(false);
    });

    it('does not flag a device that could not hash at all', async () => {
      // An insecure origin has no SubtleCrypto. The column means "we checked
      // and they differed", never "we could not check".
      expect(await record(null)).toBe(false);
    });

    it('does not flag a locale the notice was never published in', async () => {
      // `body_sha256` is a map, and a version says nothing at all in a locale
      // it was not written in. Absent is not different.
      expect(await record('0'.repeat(64), 'kn')).toBe(false);
    });
  });

  it('cannot be edited or deleted by the request path', async () => {
    const [row] = await ownerDb()
      .select({ id: consentEvents.id })
      .from(consentEvents)
      .limit(1);

    await expect(
      appDb.execute(sql`UPDATE consent_events SET action = 'withdrawn' WHERE id = ${row!.id}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      appDb.execute(sql`DELETE FROM consent_events WHERE id = ${row!.id}`),
    ).rejects.toThrow(/permission denied/i);

    // And the owner is refused too, by the trigger — a withdrawal is appended.
    await expect(
      ownerDb().execute(sql`UPDATE consent_events SET action = 'withdrawn' WHERE id = ${row!.id}`),
    ).rejects.toThrow(/may only be amended by redacting/i);
  });

  it('gives each organisation a different pseudonym for the same person', async () => {
    // Otherwise a matching pseudonym across two tenants would leak that a
    // record had been copied between them.
    const a = subjectPseudonym('org-a', sunita);
    const b = subjectPseudonym('org-b', sunita);

    expect(a).not.toBe(b);
    expect(a).toBe(subjectPseudonym('org-a', sunita));
    expect(a).toHaveLength(64);
  });
  it('counts people, not people times purposes', async () => {
    /*
     * The CTE holds one row per (subject, purpose), and these two figures used
     * a plain `count(*)` while the two beside them correctly counted distinct
     * subjects. So one child under a three-purpose notice reported as
     * "Children with no guardian: 3" — the number an administrator acts on,
     * inflated by however many purposes their notice happens to cover.
     */
    const [type] = await ownerDb()
      .select({ id: subjects.subjectTypeId })
      .from(subjects)
      .where(eq(subjects.id, child))
      .limit(1);

    const [child2] = await ownerDb()
      .insert(subjects)
      .values({
        orgId: org.id,
        subjectTypeId: type!.id,
        displayName: 'Second Child',
        locationId: org.villageAId,
        createdBy: org.workerAId,
      })
      .returning({ id: subjects.id });

    const before = await consentSummary(ownerDb(), org.id);

    // The same child, under both purposes the notice covers.
    await recordConsentEvents(ownerDb(), actor(), [
      {
        clientEventUuid: randomUUID(),
        subjectId: child2!.id,
        purposeId: mealsId,
        action: 'given',
        lawfulBasis: 'guardian_consent',
        noticeVersionId,
        subjectIsMinor: true,
        guardianVerified: false,
      },
      {
        clientEventUuid: randomUUID(),
        subjectId: child2!.id,
        purposeId: schemeId,
        action: 'given',
        lawfulBasis: 'guardian_consent',
        noticeVersionId,
        subjectIsMinor: true,
        guardianVerified: false,
      },
    ]);

    const after = await consentSummary(ownerDb(), org.id);

    // One more child, not two.
    expect(after.childrenWithoutGuardian).toBe(before.childrenWithoutGuardian + 1);
  });

});

describe.skipIf(!hasDatabase)('a child with no guardian', () => {
  let org: TestOrg;
  let purposeId: string;
  let noticeVersionId: string;
  let childId: string;

  beforeAll(async () => {
    org = await createTestOrg('guardian');
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

    const registration = await publishForm(org, 'reg', [{ key: 'name', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });
    childId = (
      await ownerDb()
        .insert(subjects)
        .values({
          orgId: org.id,
          subjectTypeId: registration.subjectTypeId,
          displayName: 'A Child',
          attributes: {},
          createdBy: org.workerAId,
        })
        .returning({ id: subjects.id })
    )[0]!.id;

    await recordConsentEvents(
      ownerDb(),
      { orgId: org.id, userId: org.workerAId, role: 'field_worker' },
      [
        {
          clientEventUuid: randomUUID(),
          subjectId: childId,
          purposeId,
          action: 'given',
          lawfulBasis: 'consent',
          noticeVersionId,
          subjectIsMinor: true,
          minorBasis: 'worker_declared',
          guardianVerified: false,
          pendingOverride: true,
        },
      ],
    );
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('waits for a supervisor rather than blocking the worker', async () => {
    // Asynchronous on purpose: a supervisor is not standing in the village.
    const waiting = await pendingOverrides(ownerDb(), org.id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ subjectId: childId, minorBasis: 'worker_declared' });
  });

  it('stays visibly irregular after the override is approved', async () => {
    const [event] = await pendingOverrides(ownerDb(), org.id);

    await ownerDb().transaction(async (tx) => {
      await decideOverride(tx as never, event!.eventId, {
        by: org.supervisorId,
        role: 'supervisor',
        reason: 'Mother present, no document to hand; ration card seen previously.',
      });
    });

    const [row] = await ownerDb()
      .select({
        guardianVerified: consentEvents.guardianVerified,
        pendingOverride: consentEvents.pendingOverride,
        reason: consentEvents.overrideReason,
      })
      .from(consentEvents)
      .where(eq(consentEvents.id, event!.eventId));

    /*
     * The assertion the whole design turns on. Approving records that a
     * supervisor accepted the gap; it does not conjure a guardian who was never
     * there. An override that made the record look clean would be a permission,
     * not an exception.
     */
    expect(row?.guardianVerified).toBe(false);
    expect(row?.pendingOverride).toBe(false);
    expect(row?.reason).toContain('Mother present');
  });

  it('reads the attestation back for whoever reviews the record', async () => {
    /*
     * The review screen showed every answer and nothing about permission, so a
     * supervisor approving the registration of a child could not see that a
     * child was involved. Every column was being written; nothing read them.
     */
    const records = await consentRecordFor(ownerDb(), org.id, childId);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      subjectIsMinor: true,
      minorBasis: 'worker_declared',
      guardianName: null,
      guardianVerified: false,
    });
    // The notice they were actually shown, by version, so a reviewer can tell
    // which wording was read out.
    expect(records[0]?.noticeVersionNumber).not.toBeNull();
  });

  it('confines an override decision to the locations the reviewer can see', async () => {
    /*
     * `decideOverride` runs on the owner connection, because `consent_events` is
     * append-only and only the immutability trigger's exception may write to it —
     * so RLS is not scoping that statement and this check has to stand in for it.
     *
     * The boundary comes from `subjects`, not from `consent_events`: the event's
     * own policy is org-scoped, while `subjects_isolation` adds
     * `app.can_see_location`. Reaching the event through its subject is what
     * inherits the location limit.
     */
    const scopedPurposeId = await createPurpose(ownerDb(), org.id, {
      name: { en: 'check the location boundary' },
      lawfulBasis: 'consent',
      retentionMonths: 12,
    });

    // Its own pending event: an earlier test in this file clears the shared one,
    // and a check that depended on running first would be a trap for whoever
    // adds the next test.
    await recordConsentEvents(
      ownerDb(),
      { orgId: org.id, userId: org.workerAId, role: 'field_worker' },
      [
        {
          clientEventUuid: randomUUID(),
          subjectId: childId,
          purposeId: scopedPurposeId,
          action: 'given',
          lawfulBasis: 'consent',
          noticeVersionId,
          subjectIsMinor: true,
          minorBasis: 'worker_declared',
          guardianVerified: false,
          pendingOverride: true,
        },
      ],
    );
    const [fresh] = await ownerDb()
      .select({ id: consentEvents.id })
      .from(consentEvents)
      .where(and(eq(consentEvents.purposeId, scopedPurposeId), eq(consentEvents.pendingOverride, true)))
      .limit(1);
    const pendingEventId = fresh!.id;

    const appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 2);
    const appDb = drizzle(appClient) as unknown as Database;

    const seenBy = async (userId: string, role: string) =>
      appDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
        await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
        await tx.execute(sql`select set_config('app.role', ${role}, true)`);
        return isOverrideVisible(tx as never, org.id, pendingEventId);
      });

    const moveChildTo = (locationId: string) =>
      ownerDb().update(subjects).set({ locationId }).where(eq(subjects.id, childId));

    try {
      // Worker A is assigned to village A only.
      await moveChildTo(org.villageAId);
      expect(await seenBy(org.workerAId, 'field_worker')).toBe(true);

      // Same event, same worker, child now somewhere they cannot see.
      await moveChildTo(org.villageBId);
      expect(await seenBy(org.workerAId, 'field_worker')).toBe(false);

      // The supervisor covers the whole block, so they still see it.
      expect(await seenBy(org.supervisorId, 'supervisor')).toBe(true);
    } finally {
      await moveChildTo(org.villageAId);
      await appClient.end();
      /*
       * Removed again, so this test does not change what the later counts see.
       * `consent_events` is append-only, so the delete needs the same declared
       * exception erasure uses — which is exactly why a test that leaves rows
       * behind is worth avoiding rather than working around.
       */
      await ownerDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.allow_purge', 'on', true)`);
        await tx.execute(sql`DELETE FROM consent_events WHERE id = ${pendingEventId}::uuid`);
        await tx.execute(sql`DELETE FROM purposes WHERE id = ${scopedPurposeId}::uuid`);
      });
    }
  });

  it('counts children without a guardian, so nobody has to notice', async () => {
    const summary = await consentSummary(ownerDb(), org.id);
    expect(summary.childrenWithoutGuardian).toBe(1);
    expect(summary.overridesPending).toBe(0);
  });

});
