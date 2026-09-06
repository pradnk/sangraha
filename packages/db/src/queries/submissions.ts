import {
  aliasedTable,
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  max,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { I18nText, SubmissionData } from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { forms } from '../schema/config';
import { locations, users } from '../schema/tenancy';
import { subjects, submissionRevisions, submissions } from '../schema/data';

/**
 * Reads over collected data.
 *
 * Every function here takes a transaction from `withContext`, so what comes
 * back is already constrained by Row-Level Security: a field worker sees their
 * own submissions, a supervisor their location subtree, an admin the whole
 * organisation. The policies are the boundary and nothing here re-implements
 * them — the one option that mentions a user, `submittedBy`, narrows within
 * what the caller can already see rather than deciding what that is.
 */

export type SubmissionStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface SubmissionListItem {
  id: string;
  formId: string;
  formSlug: string;
  formName: I18nText;
  formVersionId: string;
  status: SubmissionStatus;
  submittedAt: Date;
  data: SubmissionData;
  subjectName: string | null;
  locationName: I18nText | null;
  /** Needed by the review queue to apply the four-eyes rule before a tap. */
  submittedBy: string;
  submittedByName: string | null;
}

export interface ListSubmissionsOptions {
  formId?: string;
  status?: SubmissionStatus[];
  limit?: number;
  offset?: number;
  /**
   * Whose submissions, when the answer has to be "this person's".
   *
   * The policies are the tenant and location boundary and this is not a second
   * copy of them — it narrows *within* what the caller may already see. Needed
   * because `submissions_isolation` only restricts to `submitted_by` for a
   * `field_worker`: a supervisor opening a screen called "My submissions" was
   * shown everybody's, which is a page that means something different
   * depending on who is reading it.
   */
  submittedBy?: string;
}

export async function listSubmissions(
  db: DbLike,
  options: ListSubmissionsOptions = {},
): Promise<SubmissionListItem[]> {
  const filters: SQL[] = [isNull(submissions.deletedAt)];
  if (options.formId) filters.push(eq(submissions.formId, options.formId));
  if (options.status?.length) filters.push(inArray(submissions.status, options.status));
  if (options.submittedBy) filters.push(eq(submissions.submittedBy, options.submittedBy));

  const rows = await db
    .select({
      id: submissions.id,
      formId: submissions.formId,
      formSlug: forms.slug,
      formName: forms.name,
      formVersionId: submissions.formVersionId,
      status: submissions.status,
      submittedAt: submissions.submittedAt,
      data: submissions.data,
      subjectName: subjects.displayName,
      locationName: locations.name,
      submittedBy: submissions.submittedBy,
      submittedByName: users.fullName,
    })
    .from(submissions)
    .innerJoin(forms, eq(forms.id, submissions.formId))
    .leftJoin(subjects, eq(subjects.id, submissions.subjectId))
    .leftJoin(locations, eq(locations.id, submissions.locationId))
    .leftJoin(users, eq(users.id, submissions.submittedBy))
    .where(and(...filters))
    .orderBy(desc(submissions.submittedAt))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);

  return rows as SubmissionListItem[];
}

export async function countSubmissions(
  db: DbLike,
  options: Pick<ListSubmissionsOptions, 'formId' | 'status'> = {},
): Promise<number> {
  const filters: SQL[] = [isNull(submissions.deletedAt)];
  if (options.formId) filters.push(eq(submissions.formId, options.formId));
  if (options.status?.length) filters.push(inArray(submissions.status, options.status));

  const [row] = await db
    .select({ total: count() })
    .from(submissions)
    .where(and(...filters));

  return row?.total ?? 0;
}

export interface SubmissionDetail extends SubmissionListItem {
  /**
   * The person this is about, so a screen can link to them.
   *
   * `subjectName` alone is a dead end — a name with nowhere to go, on the one
   * screen where the whole point is reaching the rest of their record.
   */
  subjectId: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  reviewedByName: string | null;
  clientUuid: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function getSubmission(
  db: DbLike,
  submissionId: string,
): Promise<SubmissionDetail | null> {
  const reviewer = aliasedTable(users, 'reviewer');

  const [row] = await db
    .select({
      id: submissions.id,
      formId: submissions.formId,
      formSlug: forms.slug,
      formName: forms.name,
      formVersionId: submissions.formVersionId,
      status: submissions.status,
      submittedAt: submissions.submittedAt,
      data: submissions.data,
      subjectId: submissions.subjectId,
      subjectName: subjects.displayName,
      locationName: locations.name,
      // Declared by `SubmissionListItem` and never selected here, so the cast
      // below was returning an object that did not match its own type. Nothing
      // read it yet, which is the only reason it went unnoticed.
      submittedBy: submissions.submittedBy,
      submittedByName: users.fullName,
      reviewNote: submissions.reviewNote,
      reviewedAt: submissions.reviewedAt,
      reviewedByName: reviewer.fullName,
      clientUuid: submissions.clientUuid,
      createdAt: submissions.createdAt,
      updatedAt: submissions.updatedAt,
    })
    .from(submissions)
    .innerJoin(forms, eq(forms.id, submissions.formId))
    .leftJoin(subjects, eq(subjects.id, submissions.subjectId))
    .leftJoin(locations, eq(locations.id, submissions.locationId))
    .leftJoin(users, eq(users.id, submissions.submittedBy))
    // A second alias rather than a correlated subquery: an interpolated column
    // inside a subquery renders unqualified and can bind to the wrong table.
    .leftJoin(reviewer, eq(reviewer.id, submissions.reviewedBy))
    .where(and(eq(submissions.id, submissionId), isNull(submissions.deletedAt)))
    .limit(1);

  return (row as SubmissionDetail | undefined) ?? null;
}

/** How many are waiting for a supervisor, within whatever the caller can see. */
export async function countAwaitingReview(db: DbLike): Promise<number> {
  return countSubmissions(db, { status: ['submitted'] });
}

/**
 * Approves or rejects a submission.
 *
 * Appends to `submission_revisions` rather than only stamping the row: donor
 * and statutory audits ask who changed a record's status and when, and a
 * rejection that leaves no trace is indistinguishable from data that was never
 * collected.
 *
 * Conditions enforced in the UPDATE itself, so none of them depends on the
 * caller having checked first:
 *
 *   - the row must be visible to the caller (RLS filters the statement, so an
 *     out-of-scope id simply matches nothing)
 *   - it must still be `submitted`, which makes a double-tap on Approve a no-op
 *     rather than a second revision
 *   - for a supervisor, the reviewer must not be the person who submitted it
 *
 * That last one is the four-eyes rule, and it applies to supervisors because
 * supervisors capture data too — self-approval would quietly hollow out the
 * review step for exactly the people it exists to check.
 *
 * **An org admin is exempt.** Not a weakening of the rule so much as an
 * acknowledgement of who they already are: they control users, forms, roles and
 * every other setting, so requiring a second pair of eyes buys no real
 * protection. What it did buy was a dead end — a two-person NGO where the admin
 * captures data had records nobody in the organisation could ever approve. The
 * act is recorded rather than hidden: `reviewed_by = submitted_by` is visible
 * in the audit trail and surfaces as `self_reviewed` in the analytics views.
 *
 * Returns *why* it failed rather than a bare false, because the three reasons
 * need three different things said to the person in front of the screen.
 */
export type ReviewFailure =
  /** No such record, or outside the reviewer's locations. RLS hid it. */
  | 'not_found'
  /** Somebody already approved or sent it back. */
  | 'already_reviewed'
  /** The reviewer sent it themselves, and is not an admin. */
  | 'own_submission';

export type ReviewResult = { ok: true; selfReviewed: boolean } | { ok: false; reason: ReviewFailure };

/** Roles the four-eyes rule does not apply to. */
const MAY_REVIEW_OWN: readonly string[] = ['org_admin', 'super_admin'];

export async function reviewSubmission(
  db: DbLike,
  input: {
    submissionId: string;
    decision: 'approved' | 'rejected';
    reviewerId: string;
    /** Decides whether the four-eyes rule applies. */
    reviewerRole: string;
    note?: string | null;
  },
): Promise<ReviewResult> {
  const now = new Date();
  const mayReviewOwn = MAY_REVIEW_OWN.includes(input.reviewerRole);

  const conditions = [
    eq(submissions.id, input.submissionId),
    eq(submissions.status, 'submitted'),
  ];
  if (!mayReviewOwn) conditions.push(ne(submissions.submittedBy, input.reviewerId));

  const [updated] = await db
    .update(submissions)
    .set({
      status: input.decision,
      reviewedBy: input.reviewerId,
      reviewedAt: now,
      reviewNote: input.note ?? null,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning({
      id: submissions.id,
      data: submissions.data,
      submittedBy: submissions.submittedBy,
    });

  if (!updated) {
    /*
     * Work out which of the three it was, so the screen can say something
     * true. Read separately and only on the failure path: the UPDATE above is
     * what enforces the rules, and re-deriving them here would be a second
     * implementation waiting to disagree with the first.
     */
    const [row] = await db
      .select({ status: submissions.status, submittedBy: submissions.submittedBy })
      .from(submissions)
      .where(eq(submissions.id, input.submissionId))
      .limit(1);

    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'submitted') return { ok: false, reason: 'already_reviewed' };
    return { ok: false, reason: 'own_submission' };
  }

  const [last] = await db
    .select({ revisionNo: submissionRevisions.revisionNo })
    .from(submissionRevisions)
    .where(eq(submissionRevisions.submissionId, input.submissionId))
    .orderBy(desc(submissionRevisions.revisionNo))
    .limit(1);

  await db.insert(submissionRevisions).values({
    submissionId: input.submissionId,
    revisionNo: (last?.revisionNo ?? 0) + 1,
    changeType: 'status_changed',
    data: updated.data,
    status: input.decision,
    changedBy: input.reviewerId,
    reason: input.note ?? null,
  });

  return { ok: true, selfReviewed: updated.submittedBy === input.reviewerId };
}

/**
 * Approves several records at once.
 *
 * A supervisor with fifty attendance records they can already judge from the
 * list should not have to open fifty screens. Everything the single decision
 * enforces still applies here — it is the same rules in one statement, not a
 * looser path that happens to be faster:
 *
 *   - Row-Level Security filters the UPDATE, so ids outside the reviewer's
 *     locations simply match nothing
 *   - already-decided records are left alone, so two supervisors working the
 *     queue at once cannot overwrite each other
 *   - the four-eyes rule holds per record, so a supervisor's own submissions
 *     are refused even when swept up in "select all"
 *
 * **Approve only.** There is no bulk send-back, deliberately: a rejection
 * requires a reason the worker can act on, and one reason pasted across twenty
 * different records is not a reason.
 *
 * Reports what it did *and* what it declined to do. Silently approving 17 of 20
 * and saying "done" is how a supervisor comes to believe a queue is empty.
 */
export interface BulkApprovalResult {
  approved: number;
  /** Approved by the person who submitted them — an org admin. Recorded. */
  selfApproved: number;
  /** Refused: the reviewer sent them and is not an admin. */
  skippedOwn: number;
  /** Somebody else had already decided them. */
  skippedAlready: number;
  /** Gone, or outside the reviewer's locations. */
  skippedMissing: number;
}

export async function approveSubmissions(
  db: DbLike,
  input: { submissionIds: string[]; reviewerId: string; reviewerRole: string },
): Promise<BulkApprovalResult> {
  const empty: BulkApprovalResult = {
    approved: 0,
    selfApproved: 0,
    skippedOwn: 0,
    skippedAlready: 0,
    skippedMissing: 0,
  };
  if (input.submissionIds.length === 0) return empty;

  const ids = [...new Set(input.submissionIds)];
  const now = new Date();
  const mayReviewOwn = MAY_REVIEW_OWN.includes(input.reviewerRole);

  const conditions = [inArray(submissions.id, ids), eq(submissions.status, 'submitted')];
  if (!mayReviewOwn) conditions.push(ne(submissions.submittedBy, input.reviewerId));

  const updated = await db
    .update(submissions)
    .set({
      status: 'approved',
      reviewedBy: input.reviewerId,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning({
      id: submissions.id,
      data: submissions.data,
      submittedBy: submissions.submittedBy,
    });

  const done = new Set(updated.map((row) => row.id));

  // Classify the rest, so the screen can say which ones did not go through and
  // why rather than quietly reporting a smaller number.
  const result: BulkApprovalResult = {
    ...empty,
    approved: updated.length,
    selfApproved: updated.filter((row) => row.submittedBy === input.reviewerId).length,
  };

  const remaining = ids.filter((id) => !done.has(id));
  if (remaining.length > 0) {
    const rows = await db
      .select({
        id: submissions.id,
        status: submissions.status,
        submittedBy: submissions.submittedBy,
      })
      .from(submissions)
      .where(inArray(submissions.id, remaining));

    const seen = new Map(rows.map((row) => [row.id, row]));
    for (const id of remaining) {
      const row = seen.get(id);
      if (!row) result.skippedMissing += 1;
      else if (row.status !== 'submitted') result.skippedAlready += 1;
      else result.skippedOwn += 1;
    }
  }

  if (updated.length === 0) return result;

  /*
   * One revision per record, so the audit trail is identical to the one a
   * record approved on its own gets. A bulk action that skipped the trail would
   * make "who approved this and when" depend on which button was pressed.
   */
  const lastRevisions = await db
    .select({
      submissionId: submissionRevisions.submissionId,
      latest: max(submissionRevisions.revisionNo),
    })
    .from(submissionRevisions)
    .where(inArray(submissionRevisions.submissionId, [...done]))
    .groupBy(submissionRevisions.submissionId);

  const latestBySubmission = new Map(
    lastRevisions.map((row) => [row.submissionId, Number(row.latest ?? 0)]),
  );

  await db.insert(submissionRevisions).values(
    updated.map((row) => ({
      submissionId: row.id,
      revisionNo: (latestBySubmission.get(row.id) ?? 0) + 1,
      changeType: 'status_changed' as const,
      data: row.data,
      status: 'approved' as const,
      changedBy: input.reviewerId,
      reason: null,
    })),
  );

  return result;
}

/**
 * Answers that must not repeat, and how they are compared.
 *
 * `trim` and lower-case, and nothing cleverer. Emails and government ID
 * numbers are routinely typed with stray spaces or in a different case, and
 * treating those as different values would make the rule useless. Going
 * further — stripping the spaces out of "1234 5678 9012", say — is tempting
 * and wrong: it would also merge two genuinely different free-text answers,
 * and the admin has no way to see that happening.
 */
export function normaliseForUniqueness(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const text = String(value).trim().toLowerCase();
  return text === '' ? null : text;
}

export interface DuplicateAnswer {
  fieldKey: string;
  value: string;
}

/**
 * Finds answers that already exist on this form, for questions marked unique.
 *
 * **Must be called inside the transaction that writes the submission.** Two
 * workers submitting the same phone number at the same moment would otherwise
 * both look, both find nothing, and both save — the classic check-then-act
 * race, and exactly the case a uniqueness rule exists to prevent. The advisory
 * lock below serialises them on the value itself: the second one waits, then
 * sees the first.
 *
 * Deliberately not a database unique index. An index cannot be added to a form
 * whose existing data already repeats, and refusing to publish over that data
 * would strand it — so the rule binds new entries and leaves history alone,
 * which an index cannot express.
 *
 * Drafts do not count: they are half-filled by definition, and a half-typed
 * phone number should not block somebody else's finished one.
 */
export async function findDuplicateAnswers(
  db: DbLike,
  input: {
    formId: string;
    /** Field keys marked unique on the version being submitted. */
    uniqueKeys: string[];
    data: SubmissionData;
    /** The submission being edited, so it does not clash with itself. */
    excludeSubmissionId?: string | null;
  },
): Promise<DuplicateAnswer[]> {
  if (input.uniqueKeys.length === 0) return [];

  const found: DuplicateAnswer[] = [];

  for (const fieldKey of input.uniqueKeys) {
    const normalised = normaliseForUniqueness(input.data[fieldKey]);
    // A blank answer is not a value. Two people who both left it empty are not
    // duplicates of one another.
    if (normalised === null) continue;

    /*
     * Held until the transaction ends, so a concurrent submission of the same
     * value on the same question waits here rather than racing past the check
     * below. Keyed on the form and the value together: unrelated questions and
     * unrelated forms never contend.
     */
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.formId}:${fieldKey}:${normalised}`}))`,
    );

    /*
     * Through `app.duplicate_answer_exists` rather than as a query here, and
     * that is the whole substance of this check rather than a detail.
     *
     * `submissions_isolation` restricts a `field_worker` to their own rows, so
     * a plain SELECT on this transaction could only ever find the caller's own
     * submissions — meaning the two-worker case described above, the one this
     * function exists for, was silently unenforced. The function is SECURITY
     * DEFINER and re-imposes `org_id` itself; see `020-rls.sql` for why that is
     * the right boundary and `can_see_location` is not.
     */
    const [clash] = (await db.execute(sql`
      SELECT app.duplicate_answer_exists(
        ${input.formId}::uuid,
        ${fieldKey},
        ${normalised},
        ${input.excludeSubmissionId ?? null}::uuid
      ) AS found
    `)) as unknown as { found: boolean }[];

    if (clash?.found) {
      found.push({ fieldKey, value: String(input.data[fieldKey]) });
    }
  }

  return found;
}

/**
 * How many records already share a value, per unique question.
 *
 * Turning the rule on cannot retroactively make old data obey it, so the
 * publish screen says what is already there rather than pretending. Silence
 * would leave an admin believing a guarantee the data does not meet.
 */
export async function countExistingDuplicates(
  db: DbLike,
  formId: string,
  fieldKey: string,
): Promise<{ value: string; count: number }[]> {
  const rows = (await db.execute(sql`
    SELECT lower(trim(s.data->>${fieldKey})) AS value, count(*)::int AS count
    FROM submissions s
    WHERE s.form_id = ${formId}
      AND s.deleted_at IS NULL
      AND s.status <> 'draft'
      AND nullif(trim(s.data->>${fieldKey}), '') IS NOT NULL
    GROUP BY 1
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT 20
  `)) as unknown as { value: string; count: number }[];

  return rows.map((row) => ({ value: row.value, count: Number(row.count) }));
}

export interface SubmissionRevisionEntry {
  revisionNo: number;
  changeType: string;
  status: SubmissionStatus;
  changedAt: Date;
  changedByName: string | null;
  reason: string | null;
}

/** The audit trail for one submission, oldest first. */
export async function getSubmissionHistory(
  db: DbLike,
  submissionId: string,
): Promise<SubmissionRevisionEntry[]> {
  const rows = await db
    .select({
      revisionNo: submissionRevisions.revisionNo,
      changeType: submissionRevisions.changeType,
      status: submissionRevisions.status,
      changedAt: submissionRevisions.changedAt,
      changedByName: users.fullName,
      reason: submissionRevisions.reason,
    })
    .from(submissionRevisions)
    .leftJoin(users, eq(users.id, submissionRevisions.changedBy))
    .where(eq(submissionRevisions.submissionId, submissionId))
    .orderBy(submissionRevisions.revisionNo);

  return rows as SubmissionRevisionEntry[];
}
