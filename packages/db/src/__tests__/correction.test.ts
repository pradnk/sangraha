/**
 * Correcting a record a supervisor sent back, through the real `mis_app`
 * connection.
 *
 * A rejection was a dead end. The reason was shown and nothing could act on it,
 * so the only route open to a worker was to capture the visit again from the
 * home screen — which leaves the rejected record rejected for ever and files a
 * *second* record for one encounter. The tests that matter here are therefore
 * less about the happy path than about the two ways a correction could quietly
 * corrupt data: by becoming a second row, and by escaping the scoping that
 * decides whose record it is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database, type RequestContext } from '../client';
import {
  correctSubmission,
  getSubmission,
  getSubmissionHistory,
  reviewSubmission,
} from '../queries/submissions';
import { submissionRevisions, submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('correcting a rejected submission', () => {
  let appClient: postgres.Sql;
  let appDb: Database;
  let org: TestOrg;
  let formId: string;
  let versionId: string;

  async function asUser<T>(context: RequestContext, work: (tx: Database) => Promise<T>) {
    return appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${context.orgId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
      await tx.execute(sql`select set_config('app.role', ${context.role}, true)`);
      return work(tx as unknown as Database);
    });
  }

  const supervisor = (): RequestContext => ({
    orgId: org.id,
    userId: org.supervisorId,
    role: 'supervisor',
  });
  const workerA = (): RequestContext => ({
    orgId: org.id,
    userId: org.workerAId,
    role: 'field_worker',
  });
  const workerB = (): RequestContext => ({
    orgId: org.id,
    userId: org.workerBId,
    role: 'field_worker',
  });

  async function seedSubmission(submittedBy: string, locationId: string): Promise<string> {
    const [row] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId,
        formVersionId: versionId,
        locationId,
        submittedBy,
        clientUuid: crypto.randomUUID(),
        status: 'submitted',
        data: { note: 'first attempt' },
      })
      .returning({ id: submissions.id });
    return row!.id;
  }

  /** A record that has been sent back, which is the only correctable state. */
  async function seedRejected(submittedBy: string, locationId: string): Promise<string> {
    const id = await seedSubmission(submittedBy, locationId);
    await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'rejected',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
        note: 'the note is wrong',
      }),
    );
    return id;
  }

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('correction');
    ({ formId, versionId } = await publishForm(org, 'notes', [
      { key: 'note', dataType: 'short_text' },
    ]));
  });

  afterAll(async () => {
    await appClient.end();
    await dropTestOrg(org);
    await closeHarness();
  });

  it('puts the record back in the queue instead of creating a second one', async () => {
    const id = await seedRejected(org.workerAId, org.villageAId);

    const before = await ownerDb()
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.formId, formId));

    const result = await asUser(workerA(), (tx) =>
      correctSubmission(tx, {
        submissionId: id,
        correctedBy: org.workerAId,
        data: { note: 'fixed' },
      }),
    );
    expect(result).toEqual({ ok: true });

    const after = await ownerDb()
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.formId, formId));

    // The whole point. One encounter, one row — a correction that inserted
    // would double-count the visit in analytics and, on a registration form,
    // put the same person in the registry twice.
    expect(after).toHaveLength(before.length);

    const detail = await asUser(workerA(), (tx) => getSubmission(tx, id));
    expect(detail?.status).toBe('submitted');
    expect(detail?.data).toEqual({ note: 'fixed' });
  });

  it('clears the old decision so the next supervisor is not shown a stale complaint', async () => {
    const id = await seedRejected(org.workerAId, org.villageAId);

    await asUser(workerA(), (tx) =>
      correctSubmission(tx, { submissionId: id, correctedBy: org.workerAId, data: { note: 'ok' } }),
    );

    const detail = await asUser(supervisor(), (tx) => getSubmission(tx, id));
    // A note complaining about answers that are no longer there, or a
    // `reviewed_by` making an untouched record look already-judged.
    expect(detail?.reviewNote).toBeNull();
    expect(detail?.reviewedAt).toBeNull();
    expect(detail?.reviewedByName).toBeNull();
  });

  it('keeps the rejection and its reason in the history', async () => {
    const id = await seedRejected(org.workerAId, org.villageAId);
    await asUser(workerA(), (tx) =>
      correctSubmission(tx, {
        submissionId: id,
        correctedBy: org.workerAId,
        data: { note: 'second attempt' },
      }),
    );

    const history = await asUser(supervisor(), (tx) => getSubmissionHistory(tx, id));

    // Clearing the columns must not erase the fact. The note lives on the
    // revision that recorded the rejection, which is where an audit reads it.
    const rejection = history.find((row) => row.status === 'rejected');
    expect(rejection?.reason).toBe('the note is wrong');

    const correction = history.find((row) => row.changeType === 'updated');
    expect(correction?.status).toBe('submitted');
    expect(correction?.changedByName).toBe('Worker A');

    /*
     * The snapshot itself, read from the table rather than through
     * `getSubmissionHistory` — that function feeds a screen and deliberately
     * does not return the answers. A revision that recorded the change without
     * recording *what it changed to* would be an audit trail that cannot
     * settle a dispute, which is the only reason it exists.
     */
    const [snapshot] = await ownerDb()
      .select({ data: submissionRevisions.data, changedBy: submissionRevisions.changedBy })
      .from(submissionRevisions)
      .where(
        and(
          eq(submissionRevisions.submissionId, id),
          eq(submissionRevisions.changeType, 'updated'),
        ),
      );
    expect(snapshot?.data).toEqual({ note: 'second attempt' });
    expect(snapshot?.changedBy).toBe(org.workerAId);
  });

  it('lets a supervisor review the correction, which a stuck record could not be', async () => {
    const id = await seedRejected(org.workerAId, org.villageAId);
    await asUser(workerA(), (tx) =>
      correctSubmission(tx, { submissionId: id, correctedBy: org.workerAId, data: { note: 'ok' } }),
    );

    // `reviewSubmission` only acts on `submitted`, so this is what proves the
    // record actually re-entered the queue rather than merely changing colour.
    const ok = await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );
    expect(ok).toEqual({ ok: true, selfReviewed: false });
  });

  it('refuses a record that was not sent back', async () => {
    const waiting = await seedSubmission(org.workerAId, org.villageAId);

    const result = await asUser(workerA(), (tx) =>
      correctSubmission(tx, {
        submissionId: waiting,
        correctedBy: org.workerAId,
        data: { note: 'sneaking an edit past the supervisor' },
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'not_rejected' });

    const detail = await asUser(workerA(), (tx) => getSubmission(tx, waiting));
    expect(detail?.data).toEqual({ note: 'first attempt' });
  });

  it('refuses an approved record, which is no longer the worker\'s to change', async () => {
    const id = await seedSubmission(org.workerAId, org.villageAId);
    await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );

    const result = await asUser(workerA(), (tx) =>
      correctSubmission(tx, { submissionId: id, correctedBy: org.workerAId, data: { note: 'no' } }),
    );
    expect(result).toEqual({ ok: false, reason: 'not_rejected' });
  });

  it('will not let one worker correct another worker\'s record', async () => {
    const id = await seedRejected(org.workerAId, org.villageAId);

    /*
     * Not a permission check in TypeScript — `submissions_isolation` narrows a
     * field worker to their own rows, so worker B's UPDATE matches nothing and
     * the follow-up read finds nothing either. It has to surface as
     * `not_found` rather than `not_rejected`, because the second would confirm
     * the record exists.
     */
    const result = await asUser(workerB(), (tx) =>
      correctSubmission(tx, {
        submissionId: id,
        correctedBy: org.workerBId,
        data: { note: 'not mine to touch' },
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });

    const detail = await asUser(workerA(), (tx) => getSubmission(tx, id));
    expect(detail?.data).toEqual({ note: 'first attempt' });
    expect(detail?.status).toBe('rejected');
  });

  it('treats a replay from the retry queue as already done', async () => {
    const id = await seedRejected(org.workerAId, org.villageAId);

    const first = await asUser(workerA(), (tx) =>
      correctSubmission(tx, {
        submissionId: id,
        correctedBy: org.workerAId,
        data: { note: 'corrected once' },
      }),
    );
    expect(first).toEqual({ ok: true });

    /*
     * The queue re-sends whenever a response is lost on the way back, and by
     * then the record is already `submitted`. A second application would write
     * a second `updated` revision for one act, and — if a supervisor had
     * approved it in between — silently drag an approved record back into the
     * queue.
     */
    const replay = await asUser(workerA(), (tx) =>
      correctSubmission(tx, {
        submissionId: id,
        correctedBy: org.workerAId,
        data: { note: 'corrected once' },
      }),
    );
    expect(replay).toEqual({ ok: false, reason: 'not_rejected' });

    const history = await asUser(workerA(), (tx) => getSubmissionHistory(tx, id));
    expect(history.filter((row) => row.changeType === 'updated')).toHaveLength(1);
  });

  it('does not leak across the tenant boundary', async () => {
    const id = await seedRejected(org.workerAId, org.villageAId);
    const other = await createTestOrg('correction-other');

    try {
      const result = await asUser(
        { orgId: other.id, userId: other.workerAId, role: 'field_worker' },
        (tx) =>
          correctSubmission(tx, {
            submissionId: id,
            correctedBy: other.workerAId,
            data: { note: 'from another organisation' },
          }),
      );
      expect(result).toEqual({ ok: false, reason: 'not_found' });

      const [row] = await ownerDb()
        .select({ data: submissions.data, status: submissions.status })
        .from(submissions)
        .where(and(eq(submissions.id, id), eq(submissions.orgId, org.id)));
      expect(row?.data).toEqual({ note: 'first attempt' });
      expect(row?.status).toBe('rejected');
    } finally {
      await dropTestOrg(other);
    }
  });
});
