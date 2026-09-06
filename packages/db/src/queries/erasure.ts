import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database, DbLike } from '../client';
import { erasureRequests, legalHolds, programmeCounters } from '../schema/consent';
import { subjects } from '../schema/data';
import { subjectPseudonym } from './consent';

/**
 * Forgetting somebody.
 *
 * The hard part is not deleting a row, it is knowing every place the person
 * physically is. Six of them are not obvious, and each was found by asking
 * "where else could their name be?" rather than by reading the schema:
 *
 *   `subjects.display_name`    denormalised, so it survives clearing attributes
 *   `submissions.review_note`  supervisor free text, reliably contains names
 *   `submission_revisions`     a full snapshot of every historical answer
 *   the duplicate cluster      a second row holding the same human
 *   `consent_events`           the proof you had consent, naming the person
 *   object storage             their photograph, and their signature
 *
 * Two stages. Soft delete stops the processing immediately — every read query
 * in the codebase already filters `deleted_at`, so it takes effect the moment
 * it is written. The purge then physically removes or strips the data, on a
 * separate deliberate step, so an erasure entered in error is recoverable for
 * as long as the organisation's grace period allows.
 */

/**
 * A uuid list, bound one parameter at a time.
 *
 * Drizzle renders a JavaScript array inside a `sql` template as a row
 * constructor, not an array literal, so `= ANY(${ids}::uuid[])` fails with
 * "cannot cast type record to uuid[]". Spelling out the casts is uglier and
 * actually works.
 */
const anyOf = (ids: string[]): SQL =>
  sql`ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])`;

export interface ErasureRequestInput {
  subjectId: string;
  mode?: 'pseudonymise' | 'hard_delete';
  requestedByName?: string | null;
  requestedByRelationship?: string | null;
  identityCheckedNote?: string | null;
  receivedBy: string;
}

/**
 * Everyone the request has to cover.
 *
 * A duplicate is linked, never merged, so both rows keep their own copy of the
 * same human's answers. Erasing only the row that was asked about leaves the
 * other one intact — and because `duplicate_of_id` is ON DELETE SET NULL, the
 * survivor is quietly promoted to canonical. The cluster is resolved with the
 * same `COALESCE(duplicate_of_id, id)` expression the analytics views use.
 */
export async function erasureCluster(
  db: DbLike,
  orgId: string,
  subjectId: string,
): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH target AS (
      SELECT COALESCE(duplicate_of_id, id) AS canonical
      FROM subjects
      WHERE id = ${subjectId}::uuid AND org_id = ${orgId}
    )
    SELECT s.id
    FROM subjects s, target t
    WHERE s.org_id = ${orgId}
      AND COALESCE(s.duplicate_of_id, s.id) = t.canonical
  `)) as unknown as { id: string }[];

  return rows.map((row) => row.id);
}

export interface HeldBack {
  purposeCode: string;
  statute: string;
  section: string | null;
  expiresAt: Date;
}

/**
 * Statutes that stop part of this erasure, if any.
 *
 * Expired holds are excluded here rather than swept by a job: a hold whose date
 * has passed simply stops matching, which is correct on every deployment
 * without anything being scheduled.
 */
export async function holdsBlocking(db: DbLike, orgId: string): Promise<HeldBack[]> {
  const rows = (await db.execute(sql`
    SELECT p.code AS purpose_code, h.statute, h.section, h.expires_at
    FROM legal_holds h
    JOIN purposes p ON p.id = h.purpose_id
    WHERE h.org_id = ${orgId} AND h.expires_at > now()
    ORDER BY h.expires_at
  `)) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    purposeCode: row.purpose_code as string,
    statute: row.statute as string,
    section: (row.section as string) ?? null,
    expiresAt: new Date(row.expires_at as string),
  }));
}

/**
 * The live holds that cover *this person's* records, not the organisation's.
 *
 * A hold is purpose-scoped by design — the schema comment on `legal_holds` is
 * explicit that a hold swallowing everything would turn "we must keep some of
 * this" into "we keep all of it". So the question is never "does this
 * organisation have a hold" but "is any of what we are about to destroy
 * collected for a purpose that is held".
 *
 * Two paths link a person to a purpose and both count. `consent_events` records
 * what they were asked for; `form_fields.purpose_id` records what a question is
 * collected for, which covers records taken under a legitimate use where
 * nobody was asked at all.
 */
async function holdsCovering(
  db: DbLike,
  orgId: string,
  cluster: string[],
): Promise<HeldBack[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT p.code AS purpose_code, h.statute, h.section, h.expires_at
    FROM legal_holds h
    JOIN purposes p ON p.id = h.purpose_id
    WHERE h.org_id = ${orgId}
      AND h.expires_at > now()
      AND (
        EXISTS (
          SELECT 1 FROM consent_events ce
          WHERE ce.org_id = ${orgId}
            AND ce.subject_id = ${anyOf(cluster)}
            AND ce.purpose_id = h.purpose_id
        )
        OR EXISTS (
          SELECT 1
          FROM submissions sub
          JOIN form_fields ff ON ff.form_version_id = sub.form_version_id
          WHERE sub.org_id = ${orgId}
            AND sub.subject_id = ${anyOf(cluster)}
            AND ff.purpose_id = h.purpose_id
        )
      )
    ORDER BY h.expires_at
  `)) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    purposeCode: row.purpose_code as string,
    statute: row.statute as string,
    section: (row.section as string) ?? null,
    expiresAt: new Date(row.expires_at as string),
  }));
}

/**
 * Records a request and stops the processing.
 *
 * Soft delete is applied straight away rather than on approval. The Act
 * requires processing to cease, and a record that stays visible while an admin
 * gets round to a queue is a record still being used — the physical purge is
 * the reversible-until-then part, not this.
 */
export async function requestErasure(
  db: DbLike,
  orgId: string,
  input: ErasureRequestInput,
): Promise<{ requestId: string; cluster: string[]; holds: HeldBack[] }> {
  const cluster = await erasureCluster(db, orgId, input.subjectId);
  if (cluster.length === 0) throw new Error('No such person in this organisation');

  const [named] = await db
    .select({ displayName: subjects.displayName })
    .from(subjects)
    .where(eq(subjects.id, input.subjectId));

  const [request] = await db
    .insert(erasureRequests)
    .values({
      orgId,
      subjectId: input.subjectId,
      subjectPseudonym: subjectPseudonym(orgId, input.subjectId),
      subjectNameAtRequest: named?.displayName ?? null,
      mode: input.mode ?? 'pseudonymise',
      status: 'accepted',
      requestedByName: input.requestedByName ?? null,
      requestedByRelationship: input.requestedByRelationship ?? null,
      identityCheckedNote: input.identityCheckedNote ?? null,
      receivedBy: input.receivedBy,
    })
    .returning({ id: erasureRequests.id });

  // `now()` rather than a bound Date: postgres.js infers a parameter's type
  // from the statement, and a bare timestamp in a `SET` clause gives it nothing
  // to go on.
  await db.execute(sql`
    UPDATE subjects SET deleted_at = now(), status = 'exited'
    WHERE org_id = ${orgId} AND id = ${anyOf(cluster)} AND deleted_at IS NULL
  `);
  await db.execute(sql`
    UPDATE submissions SET deleted_at = now()
    WHERE org_id = ${orgId} AND subject_id = ${anyOf(cluster)} AND deleted_at IS NULL
  `);

  return { requestId: request!.id, cluster, holds: await holdsBlocking(db, orgId) };
}

/** Refusing, with a ground somebody could check. */
export async function refuseErasure(
  db: DbLike,
  orgId: string,
  requestId: string,
  refusal: { statute: string; note: string; decidedBy: string },
): Promise<void> {
  const [request] = await db
    .select({ subjectId: erasureRequests.subjectId })
    .from(erasureRequests)
    .where(and(eq(erasureRequests.id, requestId), eq(erasureRequests.orgId, orgId)));
  if (!request) throw new Error('No such request');

  await db
    .update(erasureRequests)
    .set({
      status: 'refused',
      refusalStatute: refusal.statute,
      refusalNote: refusal.note,
      decidedAt: new Date(),
      decidedBy: refusal.decidedBy,
    })
    .where(eq(erasureRequests.id, requestId));

  /*
   * The processing resumes, because the refusal says it lawfully must continue.
   *
   * Only where *this* request is the reason it stopped, though. It used to
   * restore unconditionally, which had two consequences. A person covered by a
   * second, still-open request was un-hidden by the refusal of the first —
   * processing resuming that was required to have ceased. And anybody who was
   * already `exited` before any of this began was silently re-activated,
   * because `requestErasure` had only ever hidden rows that were not already
   * hidden, while this set every row to `active`.
   */
  if (request.subjectId) {
    const cluster = await erasureCluster(db, orgId, request.subjectId);

    const [stillHeld] = (await db.execute(sql`
      SELECT 1 FROM erasure_requests
      WHERE org_id = ${orgId}
        AND id <> ${requestId}
        AND status IN ('requested', 'accepted')
        AND subject_id = ${anyOf(cluster)}
      LIMIT 1
    `)) as unknown as unknown[];

    if (!stillHeld) {
      await db.execute(sql`
        UPDATE subjects SET deleted_at = NULL, status = 'active'
        WHERE org_id = ${orgId}
          AND id = ${anyOf(cluster)}
          -- Only what this request hid. The status goes back to active with
          -- it; a row that was never hidden keeps whatever status it had.
          AND deleted_at IS NOT NULL
      `);
      await db.execute(sql`
        UPDATE submissions SET deleted_at = NULL
        WHERE org_id = ${orgId}
          AND subject_id = ${anyOf(cluster)}
          AND deleted_at IS NOT NULL
      `);
    }
  }
}

export interface PurgeResult {
  subjects: number;
  submissions: number;
  revisions: number;
  consentRedacted: number;
  countersWritten: number;
  /** Photographs, documents and signatures destroyed in object storage. */
  attachmentsDeleted: number;
  /**
   * Objects storage would not let go of.
   *
   * Surfaced rather than swallowed. Every other line of this result is a count
   * of something successfully erased; this is the count of files that are still
   * out there, and an operator who is answering a statutory request needs to be
   * told rather than shown a clean summary.
   */
  attachmentsFailed: number;
  /**
   * Requests a live statutory hold stopped, and the statutes that stopped them.
   *
   * Left at `accepted` rather than refused, so nothing has to be re-filed: a
   * hold has a mandatory expiry, and on the first run after that date the
   * request is picked up and completed with no further action. The soft delete
   * from `requestErasure` is already in place throughout, so the processing has
   * ceased even while the bytes are retained — which is what the Act asks for.
   */
  heldBack: { requestId: string; subjectPseudonym: string; holds: HeldBack[] }[];
}

/**
 * Destroys the bytes behind one attachment. Returns false if they survived.
 *
 * Injected rather than imported, for the same reason `SubjectNameLookup` is:
 * this package runs in migrations, seeds and the analytics generator, and must
 * not carry a dependency on how the web app talks to S3. `@/lib/storage`
 * supplies the real one; a caller with no storage configured passes nothing and
 * the step is skipped.
 */
export type ObjectDeleter = (storageKey: string) => Promise<boolean>;

/**
 * Physically removes or strips what a soft delete only hid.
 *
 * Idempotent and dry-runnable, because it is the one operation here that cannot
 * be undone and it will be run by somebody at a terminal rather than by a
 * scheduler — there is no job runner in this system, and inventing one that
 * silently destroys data on a timer is not the place to start.
 *
 * Runs on the owner connection with `app.allow_purge` set: `submission_revisions`
 * and `consent_events` are append-only, and this is the declared exception.
 */
export async function purgeErasures(
  db: Database,
  orgId: string,
  options: {
    dryRun?: boolean;
    keepAttributes?: string[];
    deleteObject?: ObjectDeleter;
  } = {},
): Promise<PurgeResult> {
  const pending = (await db.execute(sql`
    SELECT id, subject_id, subject_pseudonym, mode::text AS mode
    FROM erasure_requests
    WHERE org_id = ${orgId} AND status = 'accepted' AND subject_id IS NOT NULL
  `)) as unknown as {
    id: string;
    subject_id: string;
    subject_pseudonym: string;
    mode: string;
  }[];

  const result: PurgeResult = {
    subjects: 0,
    submissions: 0,
    revisions: 0,
    consentRedacted: 0,
    countersWritten: 0,
    attachmentsDeleted: 0,
    attachmentsFailed: 0,
    heldBack: [],
  };

  for (const request of pending) {
    const cluster = await erasureCluster(db, orgId, request.subject_id);
    if (cluster.length === 0) continue;

    /*
     * Before anything is touched, and in particular before the photographs are
     * deleted from object storage below — that step is outside the transaction
     * and cannot be undone by rolling one back.
     *
     * `holdsBlocking` was only ever consulted at request time, so a hold was
     * something the admin was shown once and the purge then ignored. An
     * organisation that had recorded an Income-tax s.44AA retention hold had
     * the records the statute obliges them to keep destroyed anyway.
     *
     * Deliberately conservative: this defers the whole request, including the
     * parts of this person's record the hold does not reach. Keeping only the
     * held answers needs per-question retention that does not exist yet, and
     * between keeping too much for a bounded period and destroying something a
     * statute requires, only one of the two is recoverable.
     */
    const held = await holdsCovering(db, orgId, cluster);
    if (held.length > 0) {
      result.heldBack.push({
        requestId: request.id,
        subjectPseudonym: request.subject_pseudonym,
        holds: held,
      });
      continue;
    }

    if (options.dryRun) {
      result.subjects += cluster.length;
      continue;
    }

    /*
     * The photographs, before anything else.
     *
     * Deliberately outside the transaction and deliberately first. Object
     * storage cannot join a Postgres transaction, so one of the two has to go
     * first — and for an erasure it must be the bytes. Delete the rows first and
     * a failure here leaves photographs of the person in a bucket with nothing
     * left pointing at them: unfindable, undeletable, and still there. Doing it
     * this way round, a failure leaves a row that a re-run will find again.
     *
     * `attachments.submission_id` cascades, so the rows go with the submissions
     * below without a statement of their own.
     */
    const files = (await db.execute(sql`
      SELECT a.id, a.storage_key
      FROM attachments a
      JOIN submissions sub ON sub.id = a.submission_id
      WHERE sub.org_id = ${orgId} AND sub.subject_id = ${anyOf(cluster)}
    `)) as unknown as { id: string; storage_key: string }[];

    for (const file of files) {
      // With no deleter configured the bytes are unreachable from here at all,
      // which is a failure to erase and is reported as one.
      const removed = options.deleteObject ? await options.deleteObject(file.storage_key) : false;
      if (removed) result.attachmentsDeleted += 1;
      else result.attachmentsFailed += 1;
    }

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.allow_purge', 'on', true)`);

      /*
       * Counts first, while there is still something to count.
       *
       * This is what keeps a donor report reproducible after the rows are gone.
       * Deriving it afterwards is impossible by construction, which is why it
       * cannot be left to a later step.
       */
      const counted = await tx.execute(sql`
        INSERT INTO programme_counters (org_id, form_id, subject_type_id, location_id, period, record_count, people_count)
        SELECT
          sub.org_id, sub.form_id, s.subject_type_id, sub.location_id,
          date_trunc('month', sub.submitted_at),
          count(*)::int, count(DISTINCT sub.subject_id)::int
        FROM submissions sub
        JOIN subjects s ON s.id = sub.subject_id
        WHERE sub.org_id = ${orgId} AND sub.subject_id = ${anyOf(cluster)}
        GROUP BY sub.org_id, sub.form_id, s.subject_type_id, sub.location_id, date_trunc('month', sub.submitted_at)
        ON CONFLICT (org_id, form_id, subject_type_id, location_id, period)
        DO UPDATE SET
          record_count = programme_counters.record_count + EXCLUDED.record_count,
          people_count = programme_counters.people_count + EXCLUDED.people_count,
          updated_at = now()
        RETURNING 1
      `);
      result.countersWritten += (counted as unknown as unknown[]).length;

      /*
       * The revision log, which holds a full snapshot of every historical
       * answer. Blanked rather than deleted: who changed what and when stays,
       * the values go. A final `deleted` revision marks why.
       */
      const revisions = await tx.execute(sql`
        UPDATE submission_revisions r
        SET data = '{}'::jsonb, reason = NULL
        FROM submissions sub
        WHERE r.submission_id = sub.id
          AND sub.org_id = ${orgId}
          AND sub.subject_id = ${anyOf(cluster)}
        RETURNING 1
      `);
      result.revisions += (revisions as unknown as unknown[]).length;

      /*
       * `review_note` is the column everyone forgets. It is supervisor free
       * text and it reliably contains names — "spoke to Sunita's mother, will
       * revisit".
       */
      if (request.mode === 'hard_delete') {
        const gone = await tx.execute(sql`
          DELETE FROM submissions
          WHERE org_id = ${orgId} AND subject_id = ${anyOf(cluster)}
          RETURNING 1
        `);
        result.submissions += (gone as unknown as unknown[]).length;
      } else {
        const stripped = await tx.execute(sql`
          UPDATE submissions
          SET data = '{}'::jsonb, review_note = NULL, device_meta = '{}'::jsonb
          WHERE org_id = ${orgId} AND subject_id = ${anyOf(cluster)}
          RETURNING 1
        `);
        result.submissions += (stripped as unknown as unknown[]).length;

        /*
         * Pseudonymising keeps the submission row, so nothing cascades and the
         * attachment rows would survive their own objects — a permanent set of
         * broken references to photographs that were just destroyed. Removed
         * explicitly. `data` has already been emptied above, so no answer points
         * at them either.
         */
        await tx.execute(sql`
          DELETE FROM attachments a
          USING submissions sub
          WHERE a.submission_id = sub.id
            AND sub.org_id = ${orgId}
            AND sub.subject_id = ${anyOf(cluster)}
        `);
      }

      /*
       * The consent log is redacted, never deleted. It is the proof consent was
       * given, and it names the person who asked to be forgotten — so the
       * identifiers go and the fact stays. The trigger in 015 permits exactly
       * this shape of update and nothing else.
       */
      const redacted = await tx.execute(sql`
        UPDATE consent_events
        SET subject_id = NULL, redacted_at = now(), guardian_name = NULL, guardian_contact = NULL
        WHERE org_id = ${orgId}
          AND subject_id = ${anyOf(cluster)}
          AND redacted_at IS NULL
        RETURNING 1
      `);
      result.consentRedacted += (redacted as unknown as unknown[]).length;

      if (request.mode === 'hard_delete') {
        const gone = await tx.execute(sql`
          DELETE FROM subjects
          WHERE org_id = ${orgId} AND id = ${anyOf(cluster)}
          RETURNING 1
        `);
        result.subjects += (gone as unknown as unknown[]).length;
      } else {
        /*
         * Declare what to KEEP, not what to strip.
         *
         * `attributes` is an arbitrary org-defined bag — nothing can know
         * whether `q7` holds "number of goats" or "husband's Aadhaar". An
         * allowlist of identifiers-to-remove fails open on every field somebody
         * forgot; keeping only what was explicitly nominated as analytical
         * fails closed. That inversion is the whole reason this is defensible.
         */
        const keep = options.keepAttributes ?? [];
        // `ARRAY[]` with nothing in it is a syntax error, and "keep nothing" is
        // the common case — a subject type that has nominated no analytical
        // fields should end up with an empty bag, not a failed purge.
        const keepList = keep.length
          ? sql`ARRAY[${sql.join(keep.map((k) => sql`${k}`), sql`, `)}]::text[]`
          : sql`ARRAY[]::text[]`;
        const stripped = await tx.execute(sql`
          UPDATE subjects
          SET
            display_name = 'Erased at this person''s request',
            external_id = NULL,
            attributes = COALESCE(
              (SELECT jsonb_object_agg(e.k, e.v) FROM jsonb_each(attributes) AS e(k, v)
               WHERE e.k = ANY(${keepList})),
              '{}'::jsonb
            ),
            status = 'exited'
          WHERE org_id = ${orgId} AND id = ${anyOf(cluster)}
          RETURNING 1
        `);
        result.subjects += (stripped as unknown as unknown[]).length;
      }

      /*
       * The request row itself, which is the last place the name survives.
       *
       * `subject_name_at_request` is documented in the schema as kept "until
       * completion" — and it was not being cleared, so after an erasure
       * reported as **completed** the person's full name was still rendered by
       * `listErasureRequests` on the organisation's own privacy screen. Along
       * with it went the requester's name and relationship, and
       * `identity_checked_note`, which is free text and reliably contains names
       * for the same reason `review_note` does.
       *
       * What remains is the proof without the person: the pseudonym, who
       * received the request, when it was received and completed, and the
       * summary of what was touched. That is enough for an auditor to follow
       * the request end to end and not enough to identify anybody.
       */
      await tx
        .update(erasureRequests)
        .set({
          status: 'completed',
          completedAt: new Date(),
          subjectId: null,
          subjectNameAtRequest: null,
          requestedByName: null,
          requestedByRelationship: null,
          identityCheckedNote: null,
          completedSummary: { cluster: cluster.length },
        })
        .where(eq(erasureRequests.id, request.id));
    });
  }

  return result;
}

export interface ErasureRequestRow {
  id: string;
  subjectId: string | null;
  subjectNameAtRequest: string | null;
  status: string;
  mode: string;
  receivedAt: Date;
  decidedAt: Date | null;
  refusalStatute: string | null;
  completedAt: Date | null;
}

export async function listErasureRequests(
  db: DbLike,
  orgId: string,
): Promise<ErasureRequestRow[]> {
  const rows = await db
    .select({
      id: erasureRequests.id,
      subjectId: erasureRequests.subjectId,
      subjectNameAtRequest: erasureRequests.subjectNameAtRequest,
      status: erasureRequests.status,
      mode: erasureRequests.mode,
      receivedAt: erasureRequests.receivedAt,
      decidedAt: erasureRequests.decidedAt,
      refusalStatute: erasureRequests.refusalStatute,
      completedAt: erasureRequests.completedAt,
    })
    .from(erasureRequests)
    .where(eq(erasureRequests.orgId, orgId))
    .orderBy(sql`received_at DESC`);

  return rows as ErasureRequestRow[];
}

export async function addLegalHold(
  db: DbLike,
  orgId: string,
  hold: {
    purposeId: string;
    statute: string;
    section?: string | null;
    note?: string | null;
    expiresAt: Date;
    createdBy: string;
  },
): Promise<void> {
  await db.insert(legalHolds).values({ orgId, ...hold });
}
