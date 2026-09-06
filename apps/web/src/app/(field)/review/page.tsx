import { listSubmissions, loadFormVersionById } from '@sangraha/db';
import { summariseSubmission } from '@sangraha/form-engine';
import { requireRole, withSession } from '@/lib/auth/guard';
import { subjectNameLookup } from '@/lib/subject-names';
import { t } from '@/lib/i18n';
import { ReviewQueue, type QueueRow } from './review-queue';

/**
 * The supervisor's queue.
 *
 * Shows only records still awaiting a decision. Scope comes from Row-Level
 * Security: a supervisor's policy limits `submissions` to their assigned
 * location subtree, resolved by ltree containment, so assigning them a block
 * covers every village under it without a query here mentioning locations at
 * all.
 */
export default async function ReviewQueuePage() {
  const session = await requireRole(['supervisor', 'org_admin']);

  // An org admin may approve their own records — there may be nobody else in
  // the organisation to do it — so for them nothing in the queue is blocked.
  const exemptFromFourEyes = session.role === 'org_admin' || session.role === 'super_admin';

  const rows = await withSession(session, async (tx) => {
    const pending = await listSubmissions(tx, { status: ['submitted'], limit: 100 });

    const versions = new Map(
      await Promise.all(
        [...new Set(pending.map((s) => s.formVersionId))].map(
          async (id) => [id, await loadFormVersionById(tx, id)] as const,
        ),
      ),
    );

    // One query for the whole queue, rather than one per row.
    const nameOf = await subjectNameLookup(
      tx,
      session.orgId,
      pending.map((s) => ({ version: versions.get(s.formVersionId) ?? undefined, data: s.data })),
    );

    return pending.map((submission): QueueRow => {
      const version = versions.get(submission.formVersionId);
      return {
          id: submission.id,
          title:
            submission.subjectName ??
            t(submission.formName, session.locale, submission.formSlug),
        summary: version
          ? summariseSubmission(version, submission.data, session.locale, 2, nameOf)
          : '',
        submittedByName: submission.submittedByName,
        submittedAt: submission.submittedAt.toISOString(),
        isOwnAndBlocked: !exemptFromFourEyes && submission.submittedBy === session.userId,
      };
    });
  });

  return <ReviewQueue rows={rows} locale={session.locale} />;
}
