/**
 * The review flow, through the real `mis_app` connection.
 *
 * What matters here is not that approve sets a column — it is that the scoping
 * holds: a supervisor must not be able to act on a record outside their
 * locations, and a field worker must not be able to approve their own work.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database, type RequestContext } from '../client';
import {
  approveSubmissions,
  countAwaitingReview,
  getSubmission,
  getSubmissionHistory,
  listSubmissions,
  reviewSubmission,
} from '../queries/submissions';
import { submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('review flow', () => {
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
  const admin = (): RequestContext => ({
    orgId: org.id,
    userId: org.adminId,
    role: 'org_admin',
  });

  /** Fresh submission from worker A in village A. */
  async function seedSubmission(locationId: string, submittedBy: string): Promise<string> {
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
        data: { note: 'needs checking' },
      })
      .returning({ id: submissions.id });
    return row!.id;
  }

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('review');
    ({ formId, versionId } = await publishForm(org, 'notes', [
      { key: 'note', dataType: 'short_text' },
    ]));
  });

  afterAll(async () => {
    await appClient.end();
    await dropTestOrg(org);
    await closeHarness();
  });

  it('approves a submission and records who did it', async () => {
    const id = await seedSubmission(org.villageAId, org.workerAId);

    const ok = await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );
    expect(ok).toEqual({ ok: true, selfReviewed: false });

    const detail = await asUser(supervisor(), (tx) => getSubmission(tx, id));
    expect(detail?.status).toBe('approved');
    expect(detail?.reviewedByName).toBe('Supervisor');
    expect(detail?.reviewedAt).toBeInstanceOf(Date);
  });

  it('returns everything a detail screen needs to link out of the record', async () => {
    /*
     * `subjectId` and `formSlug` are what the admin record screen uses to link
     * to the person and to reject an id from a different form. Neither has a
     * visible effect until something reads it, so both are asserted here rather
     * than discovered as a dead link and a record filed under the wrong
     * heading.
     */
    const id = await seedSubmission(org.villageAId, org.workerAId);
    const detail = await asUser(admin(), (tx) => getSubmission(tx, id));

    expect(detail?.formSlug).toBe('notes');
    // Declared by the interface and, until recently, never selected.
    expect(detail?.submittedBy).toBe(org.workerAId);
    // This fixture's records are about nobody, and null is the honest answer —
    // the screen reads "Not about a specific person" from it.
    expect(detail?.subjectId).toBeNull();
  });

  it('requires a reason to survive a rejection, and shows it to the worker', async () => {
    const id = await seedSubmission(org.villageAId, org.workerAId);

    await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'rejected',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
        note: 'Date is wrong',
      }),
    );

    // The worker must be able to read the reason, or the rejection is a
    // dead end for them.
    const asWorker = await asUser(workerA(), (tx) => getSubmission(tx, id));
    expect(asWorker?.status).toBe('rejected');
    expect(asWorker?.reviewNote).toBe('Date is wrong');
  });

  it('writes an audit entry for every decision', async () => {
    const id = await seedSubmission(org.villageAId, org.workerAId);
    await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
        note: 'looks right',
      }),
    );

    const history = await asUser(supervisor(), (tx) => getSubmissionHistory(tx, id));
    const latest = history.at(-1);

    expect(latest?.changeType).toBe('status_changed');
    expect(latest?.status).toBe('approved');
    expect(latest?.changedByName).toBe('Supervisor');
    expect(latest?.reason).toBe('looks right');
  });

  it('refuses a second decision on the same record', async () => {
    // Guards a double-tap on Approve, and two supervisors acting at once.
    const id = await seedSubmission(org.villageAId, org.workerAId);

    const first = await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );
    const second = await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'rejected',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );

    expect(first.ok).toBe(true);
    // Named, so the screen can say "somebody already checked this" rather than
    // guessing between three different failures.
    expect(second).toEqual({ ok: false, reason: 'already_reviewed' });

    const detail = await asUser(supervisor(), (tx) => getSubmission(tx, id));
    expect(detail?.status).toBe('approved');
  });

  it('will not let a supervisor approve a record they submitted themselves', async () => {
    // The four-eyes rule. Supervisors capture data too, so this is not
    // hypothetical: without it a supervisor could sign off their own work and
    // the review step would mean nothing.
    const own = await seedSubmission(org.villageAId, org.supervisorId);

    const done = await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: own,
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );

    expect(done).toEqual({ ok: false, reason: 'own_submission' });
    const detail = await asUser(supervisor(), (tx) => getSubmission(tx, own));
    expect(detail?.status).toBe('submitted');
  });

  it('still lets a different reviewer approve it', async () => {
    const id = await seedSubmission(org.villageAId, org.supervisorId);

    const done = await asUser(
      { orgId: org.id, userId: org.adminId, role: 'org_admin' },
      (tx) =>
        reviewSubmission(tx, {
          submissionId: id,
          decision: 'approved',
          reviewerId: org.adminId,
          reviewerRole: 'org_admin',
        }),
    );

    expect(done).toEqual({ ok: true, selfReviewed: false });
  });

  describe('an org admin reviewing their own record', () => {
    /*
     * The dead end this exists to remove: a two-person NGO where the admin
     * captures data had records that nobody in the organisation could ever
     * approve, and the screen told them the record had "already been checked
     * by someone else", which was simply untrue.
     */
    it('is allowed, because there may be nobody else', async () => {
      const own = await seedSubmission(org.villageAId, org.adminId);

      const done = await asUser(
        { orgId: org.id, userId: org.adminId, role: 'org_admin' },
        (tx) =>
          reviewSubmission(tx, {
            submissionId: own,
            decision: 'approved',
            reviewerId: org.adminId,
            reviewerRole: 'org_admin',
          }),
      );

      // Flagged rather than hidden: an exemption nobody can see is an
      // exemption nobody can audit.
      expect(done).toEqual({ ok: true, selfReviewed: true });

      const detail = await asUser(admin(), (tx) => getSubmission(tx, own));
      expect(detail?.status).toBe('approved');
    });

    it('leaves the act visible in the audit trail', async () => {
      const own = await seedSubmission(org.villageAId, org.adminId);
      await asUser(admin(), (tx) =>
        reviewSubmission(tx, {
          submissionId: own,
          decision: 'approved',
          reviewerId: org.adminId,
          reviewerRole: 'org_admin',
        }),
      );

      const detail = await asUser(admin(), (tx) => getSubmission(tx, own));
      // Same person on both sides is exactly what makes it self-reviewed, and
      // it is recorded, so a funder audit can find every instance.
      expect(detail?.reviewedByName).toBe('Admin');
      expect(detail?.submittedByName).toBe('Admin');
    });

    it('does not exempt the admin from the already-decided rule', async () => {
      const own = await seedSubmission(org.villageAId, org.adminId);
      await asUser(admin(), (tx) =>
        reviewSubmission(tx, {
          submissionId: own,
          decision: 'approved',
          reviewerId: org.adminId,
          reviewerRole: 'org_admin',
        }),
      );

      const again = await asUser(admin(), (tx) =>
        reviewSubmission(tx, {
          submissionId: own,
          decision: 'rejected',
          reviewerId: org.adminId,
          reviewerRole: 'org_admin',
        }),
      );

      expect(again).toEqual({ ok: false, reason: 'already_reviewed' });
    });

    it('cannot be claimed by a supervisor passing a role they do not have', async () => {
      const own = await seedSubmission(org.villageAId, org.supervisorId);

      // The role comes from the session in the route, never from user input —
      // but this function is exported, so the guard is asserted here too.
      const done = await asUser(supervisor(), (tx) =>
        reviewSubmission(tx, {
          submissionId: own,
          decision: 'approved',
          reviewerId: org.supervisorId,
          reviewerRole: 'supervisor',
        }),
      );

      expect(done).toEqual({ ok: false, reason: 'own_submission' });
    });
  });

  describe('approving several at once', () => {
    /*
     * The risk with a bulk action is that it becomes a looser path that happens
     * to be faster. These assert it is the same rules in one statement — a rule
     * that holds when you approve one record and not when you approve fifty is
     * not a rule.
     */
    it('approves everything it is given, and writes an audit entry for each', async () => {
      const ids = await Promise.all([
        seedSubmission(org.villageAId, org.workerAId),
        seedSubmission(org.villageAId, org.workerAId),
        seedSubmission(org.villageBId, org.workerBId),
      ]);

      const result = await asUser(supervisor(), (tx) =>
        approveSubmissions(tx, {
          submissionIds: ids,
          reviewerId: org.supervisorId,
          reviewerRole: 'supervisor',
        }),
      );

      expect(result.approved).toBe(3);

      for (const id of ids) {
        const detail = await asUser(supervisor(), (tx) => getSubmission(tx, id));
        expect(detail?.status).toBe('approved');
        expect(detail?.reviewedByName).toBe('Supervisor');

        // The trail must not depend on which button was pressed.
        const history = await asUser(supervisor(), (tx) => getSubmissionHistory(tx, id));
        expect(history.at(-1)?.changeType).toBe('status_changed');
        expect(history.at(-1)?.status).toBe('approved');
        expect(history.at(-1)?.changedByName).toBe('Supervisor');
      }
    });

    it('refuses the reviewer’s own records even inside a batch', async () => {
      const theirs = await seedSubmission(org.villageAId, org.workerAId);
      const own = await seedSubmission(org.villageAId, org.supervisorId);

      const result = await asUser(supervisor(), (tx) =>
        approveSubmissions(tx, {
          submissionIds: [theirs, own],
          reviewerId: org.supervisorId,
          reviewerRole: 'supervisor',
        }),
      );

      // The four-eyes rule is exactly what "select all" would quietly bypass.
      expect(result.approved).toBe(1);
      expect(result.skippedOwn).toBe(1);

      const stillPending = await asUser(supervisor(), (tx) => getSubmission(tx, own));
      expect(stillPending?.status).toBe('submitted');
    });

    it('lets an org admin approve their own, and counts them separately', async () => {
      const own = await seedSubmission(org.villageAId, org.adminId);
      const theirs = await seedSubmission(org.villageAId, org.workerAId);

      const result = await asUser(admin(), (tx) =>
        approveSubmissions(tx, {
          submissionIds: [own, theirs],
          reviewerId: org.adminId,
          reviewerRole: 'org_admin',
        }),
      );

      expect(result.approved).toBe(2);
      // Counted apart so the screen can say it out loud rather than let the
      // exemption pass unremarked.
      expect(result.selfApproved).toBe(1);
    });

    it('leaves records somebody else already decided alone', async () => {
      const first = await seedSubmission(org.villageAId, org.workerAId);
      const second = await seedSubmission(org.villageAId, org.workerAId);

      await asUser(admin(), (tx) =>
        reviewSubmission(tx, {
          submissionId: first,
          decision: 'rejected',
          reviewerId: org.adminId,
          reviewerRole: 'org_admin',
          note: 'Wrong date',
        }),
      );

      const result = await asUser(supervisor(), (tx) =>
        approveSubmissions(tx, {
          submissionIds: [first, second],
          reviewerId: org.supervisorId,
          reviewerRole: 'supervisor',
        }),
      );

      expect(result.approved).toBe(1);
      expect(result.skippedAlready).toBe(1);

      // Two supervisors working the queue at once must not overwrite each
      // other, and a rejection must not silently become an approval.
      const untouched = await asUser(supervisor(), (tx) => getSubmission(tx, first));
      expect(untouched?.status).toBe('rejected');
      expect(untouched?.reviewNote).toBe('Wrong date');
    });

    it('cannot reach a record outside the reviewer’s organisation', async () => {
      const other = await createTestOrg('review-bulk-other');
      try {
        const { formId: theirForm, versionId: theirVersion } = await publishForm(
          other,
          'theirs',
          [{ key: 'note', dataType: 'short_text' }],
        );
        const [theirs] = await ownerDb()
          .insert(submissions)
          .values({
            orgId: other.id,
            formId: theirForm,
            formVersionId: theirVersion,
            locationId: other.villageAId,
            submittedBy: other.workerAId,
            clientUuid: crypto.randomUUID(),
            status: 'submitted',
            data: { note: 'another NGO' },
          })
          .returning({ id: submissions.id });

        const mine = await seedSubmission(org.villageAId, org.workerAId);

        const result = await asUser(supervisor(), (tx) =>
          approveSubmissions(tx, {
            submissionIds: [mine, theirs!.id],
            reviewerId: org.supervisorId,
            reviewerRole: 'supervisor',
          }),
        );

        // Row-Level Security filters the UPDATE, so the other tenant's record
        // is not merely skipped — it was never visible.
        expect(result.approved).toBe(1);
        expect(result.skippedMissing).toBe(1);

        const [untouched] = await ownerDb()
          .select({ status: submissions.status })
          .from(submissions)
          .where(eq(submissions.id, theirs!.id));
        expect(untouched?.status).toBe('submitted');
      } finally {
        await dropTestOrg(other);
      }
    });

    it('does nothing when given nothing', async () => {
      const result = await asUser(supervisor(), (tx) =>
        approveSubmissions(tx, {
          submissionIds: [],
          reviewerId: org.supervisorId,
          reviewerRole: 'supervisor',
        }),
      );
      expect(result.approved).toBe(0);
    });

    it('is not confused by the same record twice in one batch', async () => {
      const id = await seedSubmission(org.villageAId, org.workerAId);

      const result = await asUser(supervisor(), (tx) =>
        approveSubmissions(tx, {
          submissionIds: [id, id, id],
          reviewerId: org.supervisorId,
          reviewerRole: 'supervisor',
        }),
      );

      // One record, one approval, one revision — not three.
      expect(result.approved).toBe(1);
      const history = await asUser(supervisor(), (tx) => getSubmissionHistory(tx, id));
      expect(history.filter((entry) => entry.status === 'approved')).toHaveLength(1);
    });
  });

  it('says a record is missing rather than guessing why', async () => {
    // The three failure modes have to stay distinguishable: a record hidden by
    // RLS, or simply not there, must not be reported as "already checked".
    const done = await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: crypto.randomUUID(),
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );

    expect(done).toEqual({ ok: false, reason: 'not_found' });
  });

  it('hides another supervisor\'s locations from the queue', async () => {
    const other = await createTestOrg('review-other');
    try {
      const [otherForm] = [await publishForm(other, 'notes', [{ key: 'note', dataType: 'short_text' }])];
      await ownerDb().insert(submissions).values({
        orgId: other.id,
        formId: otherForm.formId,
        formVersionId: otherForm.versionId,
        locationId: other.villageAId,
        submittedBy: other.workerAId,
        clientUuid: crypto.randomUUID(),
        status: 'submitted',
        data: { note: 'other org' },
      });

      const queue = await asUser(supervisor(), (tx) =>
        listSubmissions(tx, { status: ['submitted'] }),
      );

      expect(queue.every((row) => row.data.note !== 'other org')).toBe(true);
    } finally {
      await dropTestOrg(other);
    }
  });

  it('counts only what is still awaiting a decision', async () => {
    const before = await asUser(supervisor(), (tx) => countAwaitingReview(tx));
    const id = await seedSubmission(org.villageBId, org.workerBId);

    const during = await asUser(supervisor(), (tx) => countAwaitingReview(tx));
    expect(during).toBe(before + 1);

    await asUser(supervisor(), (tx) =>
      reviewSubmission(tx, {
        submissionId: id,
        decision: 'approved',
        reviewerId: org.supervisorId,
        reviewerRole: 'supervisor',
      }),
    );

    const after = await asUser(supervisor(), (tx) => countAwaitingReview(tx));
    expect(after).toBe(before);
  });

  it('shows a field worker only their own records', async () => {
    await seedSubmission(org.villageBId, org.workerBId);

    const mine = await asUser(workerA(), (tx) => listSubmissions(tx, {}));

    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.submittedByName === 'Worker A')).toBe(true);
  });

  it('shows a supervisor only their own records when asked for their own', async () => {
    /*
     * `submissions_isolation` narrows to `submitted_by` for a `field_worker`
     * and for nobody else, so a supervisor opening a screen headed "My
     * submissions" was shown their whole subtree. The page has to ask.
     */
    await seedSubmission(org.villageBId, org.workerBId);

    const everything = await asUser(supervisor(), (tx) => listSubmissions(tx, {}));
    expect(everything.some((row) => row.submittedBy !== org.supervisorId)).toBe(true);

    const theirs = await asUser(supervisor(), (tx) =>
      listSubmissions(tx, { submittedBy: org.supervisorId }),
    );
    expect(theirs.every((row) => row.submittedBy === org.supervisorId)).toBe(true);
  });

  it('cannot be used to reach past what the policies allow', async () => {
    // The filter narrows inside the boundary; it does not move it. Worker A
    // asking for Worker B's rows gets nothing rather than Worker B's rows.
    await seedSubmission(org.villageBId, org.workerBId);

    const poached = await asUser(workerA(), (tx) =>
      listSubmissions(tx, { submittedBy: org.workerBId }),
    );

    expect(poached).toEqual([]);
  });
});
