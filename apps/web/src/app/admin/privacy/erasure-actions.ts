'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  deleteObject,
  getOwnerDb,
  purgeErasures,
  refuseErasure,
  requestErasure,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import type { PrivacyState } from './actions';

/**
 * Honouring a request to be forgotten.
 *
 * Filing and refusing run under the session, so RLS is the tenant boundary. The
 * purge does not: it has to write to `submission_revisions` and `consent_events`,
 * which are append-only, and the escape hatch is deliberately owner-only.
 */

export async function requestErasureAction(input: {
  subjectId: string;
  mode: 'pseudonymise' | 'hard_delete';
  requestedByName?: string;
  requestedByRelationship?: string;
  identityCheckedNote?: string;
}): Promise<PrivacyState> {
  const parsed = z
    .object({
      subjectId: z.string().uuid(),
      mode: z.enum(['pseudonymise', 'hard_delete']),
      requestedByName: z.string().max(200).optional(),
      requestedByRelationship: z.string().max(100).optional(),
      /*
       * How the organisation satisfied itself this was really them. Required,
       * and free text: verification here is a worker recognising somebody they
       * have visited for two years, not a document check, and a dropdown would
       * turn that into "Other".
       */
      identityCheckedNote: z.string().trim().min(5).max(1000),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { error: 'Say how you know this is the right person. It is kept with the request.' };
  }

  const session = await requireRole(['org_admin', 'super_admin']);
  const result = await withSession(session, (tx) =>
    requestErasure(tx, session.orgId, { ...parsed.data, receivedBy: session.userId }),
  );

  revalidatePath('/admin/privacy');
  revalidatePath('/admin/records');

  /*
   * Reported rather than swallowed. The record is already hidden, but if a
   * statute covers part of it the admin has to decide what is actually erased —
   * and finding that out at purge time, after telling somebody it was done,
   * would be the wrong order.
   */
  if (result.holds.length > 0) {
    return {
      ok: true,
      error: `Hidden from everyone now. Note that ${result.holds
        .map((hold) => hold.statute)
        .join(' and ')} may require some of this to be kept — check before purging.`,
    };
  }
  return { ok: true };
}

export async function refuseErasureAction(
  requestId: string,
  statute: string,
  note: string,
): Promise<PrivacyState> {
  const parsed = z
    .object({
      requestId: z.string().uuid(),
      // "No" without a ground somebody could check is not a refusal.
      statute: z.string().trim().min(3).max(200),
      note: z.string().trim().min(10).max(1000),
    })
    .safeParse({ requestId, statute, note });
  if (!parsed.success) {
    return { error: 'Name the law you are relying on and say what it covers.' };
  }

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) =>
    refuseErasure(tx, session.orgId, parsed.data.requestId, {
      statute: parsed.data.statute,
      note: parsed.data.note,
      decidedBy: session.userId,
    }),
  );

  revalidatePath('/admin/privacy');
  return { ok: true };
}

/**
 * Carries out everything accepted and not yet purged.
 *
 * `keepAttributes` declares what to KEEP, not what to strip. `attributes` is an
 * arbitrary org-defined bag — nothing can know whether `q7` holds "number of
 * goats" or "husband's Aadhaar" — so an allowlist of identifiers-to-remove
 * fails open on every field somebody forgot, while keeping only what was
 * explicitly nominated fails closed.
 */
export interface HeldBackRequest {
  subjectPseudonym: string;
  statutes: string[];
  /** The date the last of them lifts, so the screen can say when to re-run. */
  until: string;
}

export async function purgeAction(
  keepAttributes: string[],
  dryRun = true,
): Promise<
  PrivacyState & { summary?: Record<string, number>; heldBack?: HeldBackRequest[] }
> {
  const session = await requireRole(['org_admin', 'super_admin']);
  const parsed = z.array(z.string().max(120)).max(50).safeParse(keepAttributes);
  if (!parsed.success) return { error: 'That list of fields could not be read.' };

  const { heldBack, ...counts } = await purgeErasures(getOwnerDb(), session.orgId, {
    dryRun,
    keepAttributes: parsed.data,
    // Their photograph and their signature are as much "them" as their name.
    // Passed in rather than reached for, so `purgeErasures` stays testable and
    // an installation with no object storage degrades to a reported failure
    // instead of a silent one — see `ObjectDeleter`.
    deleteObject,
  });

  revalidatePath('/admin/privacy');
  return {
    ok: true,
    summary: { ...counts },
    /*
     * Separated from the counts rather than folded in, because it is the one
     * part of the result that is not a number and not good news: these people
     * asked to be forgotten and have not been. An operator who saw only the
     * totals would reasonably conclude the queue was drained.
     */
    heldBack: heldBack.map((entry) => ({
      subjectPseudonym: entry.subjectPseudonym,
      statutes: [
        ...new Set(
          entry.holds.map((hold) =>
            hold.section ? `${hold.statute} ${hold.section}` : hold.statute,
          ),
        ),
      ],
      until: entry.holds
        .reduce((latest, hold) => (hold.expiresAt > latest ? hold.expiresAt : latest), new Date(0))
        .toISOString()
        .slice(0, 10),
    })),
  };
}
