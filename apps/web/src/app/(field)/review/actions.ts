'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  approveSubmissions,
  decideOverride,
  getOwnerDb,
  isOverrideVisible,
  reviewSubmission,
  type ReviewFailure,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { m } from '@/lib/messages';

const schema = z.object({
  submissionId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
});

export interface ReviewState {
  error?: string;
  done?: boolean;
  /**
   * The admin approved something they submitted themselves. Not an error — an
   * acknowledgement, so the exemption is never invisible to the person using
   * it.
   */
  notice?: string;
}

/**
 * Records a supervisor's decision.
 *
 * Runs under the reviewer's own RLS context, so a supervisor cannot act on a
 * record outside their location scope even by guessing an id — the UPDATE
 * simply matches no row and this returns an error rather than silently
 * succeeding.
 */
export async function submitReview(
  previousOrFormData: ReviewState | FormData,
  maybeFormData?: FormData,
): Promise<ReviewState> {
  const formData =
    maybeFormData instanceof FormData
      ? maybeFormData
      : previousOrFormData instanceof FormData
        ? previousOrFormData
        : undefined;
  if (!formData) return { error: 'Something went wrong. Please try again.' };

  const session = await requireRole(['supervisor', 'org_admin']);

  const parsed = schema.safeParse({
    submissionId: formData.get('submissionId'),
    decision: formData.get('decision'),
    note: formData.get('note') || undefined,
  });
  if (!parsed.success) return { error: 'Something went wrong. Please try again.' };

  // A rejection without a reason gives the worker nothing to act on, so the
  // note is required in that direction only.
  if (parsed.data.decision === 'rejected' && !parsed.data.note?.trim()) {
    return { error: 'Please say what needs to be corrected.' };
  }

  const result = await withSession(session, (tx) =>
    reviewSubmission(tx, {
      submissionId: parsed.data.submissionId,
      decision: parsed.data.decision,
      reviewerId: session.userId,
      // Taken from the session, never from the form. This is what decides
      // whether the four-eyes rule applies.
      reviewerRole: session.role,
      note: parsed.data.note ?? null,
    }),
  );

  if (!result.ok) return { error: reasonMessage(result.reason, session.locale) };

  revalidatePath('/review');
  revalidatePath('/');
  return {
    done: true,
    notice: result.selfReviewed ? m(session.locale, 'reviewedYourOwn') : undefined,
  };
}

/**
 * Says which of the three things actually went wrong.
 *
 * These used to share one message — "already been checked by someone else" —
 * which was a guess, and wrong for the two commonest cases. A person told
 * something untrue about why they are blocked has no way to get unblocked.
 */
function reasonMessage(reason: ReviewFailure, locale: string): string {
  switch (reason) {
    case 'already_reviewed':
      return m(locale, 'reviewAlreadyDone');
    case 'own_submission':
      return m(locale, 'reviewOwnRecord');
    case 'not_found':
      return m(locale, 'reviewNotFound');
  }
}

export interface BulkReviewState {
  error?: string;
  /** What happened, in the reviewer's language. One line per outcome. */
  summary?: string[];
  approved?: number;
}

/**
 * Approves several records in one go.
 *
 * The per-record screen stays: this is for the case where a supervisor can
 * already tell from the list, which is most attendance and most routine visits.
 * It is not a looser path — `approveSubmissions` enforces exactly the same
 * rules, per record, in one statement.
 *
 * There is no bulk send-back. A rejection needs a reason the worker can act on,
 * and one reason pasted across twenty records is not a reason.
 */
export async function approveManyAction(
  submissionIds: string[],
): Promise<BulkReviewState> {
  const session = await requireRole(['supervisor', 'org_admin']);

  const parsed = z.array(z.string().uuid()).min(1).max(200).safeParse(submissionIds);
  if (!parsed.success) return { error: 'Something went wrong. Please try again.' };

  const result = await withSession(session, (tx) =>
    approveSubmissions(tx, {
      submissionIds: parsed.data,
      reviewerId: session.userId,
      // From the session, never the form — this decides whether the four-eyes
      // rule applies.
      reviewerRole: session.role,
    }),
  );

  /*
   * Every outcome is reported, including the ones that did not happen.
   * Approving 17 of 20 and saying "done" is how a supervisor comes to believe a
   * queue is empty when it is not.
   */
  const summary: string[] = [
    result.approved > 0
      ? m(session.locale, 'approvedMany', { count: result.approved })
      : m(session.locale, 'approvedNone'),
  ];
  if (result.selfApproved > 0) {
    summary.push(m(session.locale, 'selfApprovedMany', { count: result.selfApproved }));
  }
  if (result.skippedOwn > 0) {
    summary.push(m(session.locale, 'skippedYourOwn', { count: result.skippedOwn }));
  }
  if (result.skippedAlready > 0) {
    summary.push(m(session.locale, 'skippedAlreadyDone', { count: result.skippedAlready }));
  }
  if (result.skippedMissing > 0) {
    summary.push(m(session.locale, 'skippedMissing', { count: result.skippedMissing }));
  }

  revalidatePath('/review');
  revalidatePath('/');
  return { summary, approved: result.approved };
}

/**
 * A supervisor accepting a child recorded with no guardian named.
 *
 * The same decision the admin Privacy screen offers, brought to where the
 * reviewer already is — `pendingOverrides` always described it as landing "in
 * the same queue as everything else they review", and until now it only existed
 * on a screen supervisors cannot reach.
 *
 * Two things it deliberately does not do. It never sets `guardian_verified`: a
 * supervisor accepting a gap is not a guardian appearing, and the row stays
 * visibly irregular afterwards. And it does not touch the submission — approving
 * the record is a separate act, so a supervisor who clears the flag and then
 * decides the record is wrong can still send it back.
 *
 * Runs on the owner connection with `app.allow_purge`, because `consent_events`
 * is append-only and the immutability trigger in `015-immutability.sql` permits
 * this one shape of update. Scoped by re-reading the event under the reviewer's
 * own RLS context first, so an id from outside their locations is refused before
 * the privileged write happens.
 */
export async function clearGuardianFlag(
  eventId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z
    .object({
      eventId: z.string().uuid(),
      // A minimum length, because "ok" is not a reason.
      reason: z.string().trim().min(10).max(1000),
    })
    .safeParse({ eventId, reason });
  if (!parsed.success) {
    return { ok: false, error: 'Say in a sentence what happened. It is kept with the record.' };
  }

  const session = await requireRole(['supervisor', 'org_admin', 'super_admin']);

  const visible = await withSession(session, (tx) =>
    isOverrideVisible(tx, session.orgId, parsed.data.eventId),
  );
  if (!visible) return { ok: false, error: 'That record is no longer here.' };

  await getOwnerDb().transaction(async (tx) => {
    await decideOverride(tx, parsed.data.eventId, {
      by: session.userId,
      role: session.role,
      reason: parsed.data.reason,
    });
  });

  revalidatePath('/review');
  revalidatePath('/admin/privacy');
  return { ok: true };
}
