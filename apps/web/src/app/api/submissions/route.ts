import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { collectAttachmentIds, validateSubmission } from '@sangraha/form-engine';
import {
  ConsentConflictError,
  attachments,
  claimAttachments,
  createSubjectFromRegistration,
  findDuplicateAnswers,
  loadFormVersionById,
  objectSize,
  recordConsentEvents,
  subjects,
  submissionRevisions,
  submissions,
} from '@sangraha/db';
import { localise } from '@sangraha/form-engine';
import { requireSession, withSession } from '@/lib/auth/guard';
import { consentEventSchema } from '@/lib/consent-schema';
import { ABSOLUTE_MAX_BYTES } from '@/lib/attachment-limits';

/**
 * Receives one submission from the field app.
 *
 * A plain endpoint rather than a server action because the client-side retry
 * queue needs something it can re-`fetch` on its own schedule, long after the
 * originating page may have been closed.
 */

const bodySchema = z.object({
  /** Generated on the device before the first send. The idempotency key. */
  clientUuid: z.string().uuid(),
  formVersionId: z.string().uuid(),
  subjectId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  data: z.record(z.unknown()),
  deviceMeta: z.record(z.unknown()).optional(),
  /*
   * Consent captured alongside this record.
   *
   * Rides here rather than in its own call because at registration the subject
   * does not exist yet — `createSubjectFromRegistration` creates it inside this
   * transaction. A separate request would leave a registered child with no
   * consent record if the device died in between, which is the one failure that
   * matters. `subjectId` is therefore omitted and filled in below.
   */
  consent: z.array(consentEventSchema.omit({ subjectId: true })).max(20).optional(),
});

export async function POST(request: Request) {
  const session = await requireSession();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  const body = parsed.data;

  try {
    return await captureSubmission(session, body);
  } catch (error) {
    /*
     * Out here, because in here the transaction has already rolled back.
     *
     * Any failure that is discovered *after* a write has to leave the callback
     * by throwing — a returned response resolves the promise and Drizzle
     * commits. So the only safe place to turn one into a 409 is on this side of
     * `withSession`.
     */
    if (error instanceof ConsentConflictError) {
      return NextResponse.json(
        { error: 'conflicting_replay', clientEventUuid: error.clientEventUuid },
        { status: 409 },
      );
    }
    if (error instanceof OversizedAttachmentError) {
      return NextResponse.json(
        { error: 'too_large', maxBytes: ABSOLUTE_MAX_BYTES },
        { status: 413 },
      );
    }
    throw error;
  }
}

/**
 * Replaces each attachment's declared size with the one storage actually holds.
 *
 * `sizeBytes` was written from a number the client supplied when it asked for
 * an upload URL, and nothing since has checked it: the presigned PUT signs only
 * `host`, so the browser is free to send more bytes than it said it would. Two
 * things followed from that. The size limit was advisory — a crafted client
 * could store anything up to whatever the bucket allows — and the
 * `Content-Length` the download route sets from this column was a claim rather
 * than a fact, which is a malformed response if the two disagree.
 *
 * The moment of attachment is the right place to settle it: it is the first
 * point at which the upload is definitely finished, and it happens once per
 * file rather than on every read.
 *
 * A HEAD per file inside the transaction is a real cost, and it is a small one —
 * a submission carries one or two attachments, and the alternative is a number
 * in the database that nothing has ever verified. An oversized object throws,
 * so the whole submission rolls back rather than being stored around a file the
 * organisation never agreed to hold; a browser sending exactly `file.size`, as
 * every real one does, never reaches it.
 *
 * Storage being unreachable is not treated as a violation. The bytes are
 * already up, the record is what matters, and refusing the submission would
 * lose a worker's capture over a transient S3 error.
 */
async function reconcileAttachments(
  tx: Parameters<Parameters<typeof withSession>[1]>[0],
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;

  const rows = await tx
    .select({
      id: attachments.id,
      storageKey: attachments.storageKey,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(and(inArray(attachments.id, ids), isNull(attachments.submissionId)));

  for (const row of rows) {
    const actual = await objectSize(row.storageKey);
    if (actual === null) continue;

    if (actual > ABSOLUTE_MAX_BYTES) {
      throw new OversizedAttachmentError(row.id, actual);
    }
    if (actual !== Number(row.sizeBytes)) {
      await tx
        .update(attachments)
        .set({ sizeBytes: actual })
        .where(eq(attachments.id, row.id));
    }
  }
}

/** An upload that turned out larger than the platform ceiling allows. */
class OversizedAttachmentError extends Error {
  constructor(
    readonly attachmentId: string,
    readonly actualBytes: number,
  ) {
    super(`Attachment ${attachmentId} is ${actualBytes} bytes`);
    this.name = 'OversizedAttachmentError';
  }
}

async function captureSubmission(
  session: Awaited<ReturnType<typeof requireSession>>,
  body: z.infer<typeof bodySchema>,
): Promise<NextResponse> {
  return withSession(session, async (tx) => {
    const version = await loadFormVersionById(tx, body.formVersionId);
    if (!version) {
      return NextResponse.json({ error: 'unknown_form_version' }, { status: 404 });
    }

    /*
     * The two ids the client gets to choose, resolved rather than trusted.
     *
     * Both were written straight onto the row with nothing but `z.string()
     * .uuid()` behind them, and neither foreign key carries an organisation.
     * `submissions_isolation`'s WITH CHECK does not cover the gap either — for
     * a `field_worker` it asserts only `submitted_by = app.current_user_id()`.
     *
     * So a worker could file a record against a location outside their own
     * subtree, which then fails `can_see_location` and disappears from the
     * review queue of every supervisor who should have seen it; or against
     * another tenant's subject, which `claimAttachments` would then stamp onto
     * the attachment rows.
     *
     * Looked up through the request connection, so RLS does the work: an id the
     * caller may not use resolves to nothing rather than being compared against
     * something somebody has to remember to compare it to.
     */
    if (body.locationId) {
      /*
       * `can_see_location`, not merely the organisation. `locations_isolation`
       * is org-wide — every worker can read the whole tree, which is right for
       * a place picker — so an org check alone would still let a record be
       * filed two districts away. This is the same predicate
       * `submissions_isolation` applies afterwards, which is what makes the
       * record visible to the people who should review it.
       */
      const [found] = (await tx.execute(sql`
        SELECT 1 FROM locations
        WHERE id = ${body.locationId}::uuid
          AND org_id = ${session.orgId}
          AND app.can_see_location(id)
        LIMIT 1
      `)) as unknown as unknown[];
      if (!found) {
        return NextResponse.json({ error: 'unknown_location' }, { status: 404 });
      }
    }

    if (body.subjectId) {
      // `subjects_isolation` already carries the location predicate, so RLS
      // alone settles this one; the org is asserted anyway rather than relied
      // on implicitly.
      const [found] = await tx
        .select({ id: subjects.id })
        .from(subjects)
        .where(and(eq(subjects.id, body.subjectId), eq(subjects.orgId, session.orgId)))
        .limit(1);
      if (!found) {
        return NextResponse.json({ error: 'unknown_subject' }, { status: 404 });
      }
    }

    // Re-validated on the server against the same engine the UI used. The
    // client's validation is a convenience; this is the one that counts.
    const result = validateSubmission(version, body.data);
    if (!result.ok) {
      return NextResponse.json({ error: 'validation_failed', issues: result.errors }, { status: 422 });
    }

    /*
     * A replay of the retry queue, answered before anything else.
     *
     * This has to come before the uniqueness check below, not after. The queue
     * re-sends when a response is lost on the way back, and the record is
     * already saved — so the uniqueness check would find that record, conclude
     * the phone number was taken, and refuse the worker's own submission as a
     * duplicate of itself. The queue would then report a permanent failure for
     * something that saved perfectly well.
     */
    const [alreadySent] = await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(
        and(eq(submissions.orgId, session.orgId), eq(submissions.clientUuid, body.clientUuid)),
      )
      .limit(1);

    if (alreadySent) {
      return NextResponse.json({ id: alreadySent.id, duplicate: true }, { status: 200 });
    }

    /*
     * Questions the organisation marked as unique.
     *
     * Checked before the insert and inside the same transaction, which is what
     * makes it hold: the check takes an advisory lock on the value, so two
     * workers submitting the same phone number at the same moment cannot both
     * pass. Done before the insert so a genuine duplicate is refused rather
     * than half-written and rolled back.
     */
    const uniqueKeys = version.fields
      .filter((field) => field.isUnique && !field.parentGroupId)
      .map((field) => field.key);

    const clashes = await findDuplicateAnswers(tx, {
      formId: version.formId,
      uniqueKeys,
      data: result.data,
    });

    if (clashes.length > 0) {
      const labelFor = (key: string) => {
        const field = version.fields.find((f) => f.key === key);
        return field ? localise(field.label, session.locale, key) : key;
      };

      return NextResponse.json(
        {
          error: 'duplicate_answer',
          // Named question by question: "already exists" with no clue which
          // answer is the problem leaves the worker guessing.
          issues: clashes.map((clash) => ({
            path: clash.fieldKey,
            fieldKey: clash.fieldKey,
            label: labelFor(clash.fieldKey),
            value: clash.value,
          })),
        },
        { status: 409 },
      );
    }

    /*
     * Idempotency.
     *
     * The retry queue will re-send over a flaky connection, and a response lost
     * on the way back looks exactly like a failure. Without this, a tunnel
     * between two villages turns into duplicate beneficiary visits — the most
     * common data-quality failure in field MIS systems.
     *
     * `onConflictDoNothing` plus a follow-up read means a replay returns the
     * original row rather than an error, so the queue can drain cleanly.
     */
    const [inserted] = await tx
      .insert(submissions)
      .values({
        orgId: session.orgId,
        formId: version.formId,
        formVersionId: version.id,
        subjectId: body.subjectId ?? null,
        locationId: body.locationId ?? null,
        data: result.data,
        status: 'submitted',
        submittedBy: session.userId,
        clientUuid: body.clientUuid,
        deviceMeta: body.deviceMeta ?? {},
      })
      .onConflictDoNothing({ target: [submissions.orgId, submissions.clientUuid] })
      .returning({ id: submissions.id });

    if (!inserted) {
      /*
       * Two copies of the same send arriving at once — the read above found
       * nothing for either, and this one lost the race. Kept as well as the
       * read: the read handles the common replay, this handles the collision.
       */
      const [existing] = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          and(eq(submissions.orgId, session.orgId), eq(submissions.clientUuid, body.clientUuid)),
        )
        .limit(1);

      return NextResponse.json({ id: existing?.id, duplicate: true }, { status: 200 });
    }

    /*
     * A registration form registers somebody.
     *
     * Done after the insert rather than before it, so that a replay — which
     * stops at `onConflictDoNothing` above — cannot register the same person
     * twice. Both statements are in one transaction, so a registration either
     * produces a submission and a subject or neither; a subject with no
     * submission behind it would have no answers to show.
     *
     * `subjectId` already set means the worker was shown the duplicate warning
     * and said "yes, this is the same person" — so the answers attach to the
     * existing record instead of creating a second one.
     */
    let subjectId = body.subjectId ?? null;

    if (version.formType === 'registration' && !subjectId && version.subjectTypeId) {
      const subject = await createSubjectFromRegistration(tx, {
        orgId: session.orgId,
        subjectTypeId: version.subjectTypeId,
        answers: result.data,
        locationId: body.locationId ?? null,
        createdBy: session.userId,
      });
      subjectId = subject.id;

      await tx
        .update(submissions)
        .set({ subjectId })
        .where(eq(submissions.id, inserted.id));
    }

    /*
     * Consent, in the same transaction as the record it belongs to.
     *
     * After the subject exists, and after the replay short-circuit above — so a
     * re-sent registration cannot append a second attestation for the same act.
     * The per-event `clientEventUuid` guards it again on its own.
     */
    if (body.consent?.length && subjectId) {
      /*
       * A `ConsentConflictError` is deliberately not caught here.
       *
       * Returning a response from inside this callback *resolves* it, and
       * Drizzle commits a resolved transaction. By this line the submission row
       * and possibly a new subject are already written, while the attachment
       * claim and the `created` revision below are not — so catching here left
       * a record with no audit trail and orphaned photographs, told the client
       * the send had failed, and then answered the retry from the `alreadySent`
       * short-circuit with a cheerful 200.
       *
       * Throwing is what rolls the whole thing back. The 409 is built from
       * outside the transaction, in `POST`.
       */
      await recordConsentEvents(
        tx,
        { orgId: session.orgId, userId: session.userId, role: session.role },
        body.consent.map((event) => ({ ...event, subjectId })),
      );
    }

    /*
     * Tie the uploaded files to the record that refers to them.
     *
     * The bytes were uploaded while the worker was still filling the form, so
     * their rows have been sitting unclaimed with no submission. This is the
     * moment they stop being orphans. In the same transaction as the insert, so
     * a submission never exists with its photographs still floating.
     *
     * Only rows nobody has claimed are taken, and only within this tenant —
     * `claimAttachments` runs on the RLS connection. A client that echoed back
     * an id belonging to someone else claims nothing, and is left with a
     * reference that resolves to a 404 rather than to another organisation's
     * photograph.
     */
    const claiming = collectAttachmentIds(version, result.data);
    await reconcileAttachments(tx, claiming);
    await claimAttachments(tx, claiming, inserted.id, subjectId);

    // First revision, so the audit trail starts at creation rather than at the
    // first correction.
    await tx.insert(submissionRevisions).values({
      submissionId: inserted.id,
      revisionNo: 1,
      changeType: 'created',
      data: result.data,
      status: 'submitted',
      changedBy: session.userId,
    });

    return NextResponse.json(
      { id: inserted.id, subjectId, duplicate: false },
      { status: 201 },
    );
  });
}
