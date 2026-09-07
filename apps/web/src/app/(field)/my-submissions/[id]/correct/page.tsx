import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getSubmission, loadFormVersionById } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { FormCapture } from '@/components/field/form-capture';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';

/**
 * Fixing a record a supervisor sent back.
 *
 * A rejection used to be a dead end: the reason was shown on the record and
 * there was nothing to press. The worker's only way to act on it was to capture
 * the whole visit again from the home screen, which produces a *second* record
 * — the first one stays rejected for ever, and for a registration form the
 * registry gains a duplicate person. So the one route that was open was also
 * the one that quietly corrupted the data.
 *
 * The same capture UI as a first send, seeded with what was already sent. A
 * worker who mistyped one digit of a phone number should be fixing that digit,
 * not re-answering forty questions — and re-keying is itself how a correction
 * introduces a new error into an answer that was right.
 *
 * Rendered against the version the record was captured under, exactly as the
 * read-only view is. Correcting an answer must not silently re-key it to a form
 * that has been republished since.
 */
export default async function CorrectSubmissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const loaded = await withSession(session, async (tx) => {
    // RLS decides visibility: a field worker sees only their own, so somebody
    // else's record is `notFound` rather than a 403 about a record they should
    // not know exists.
    const submission = await getSubmission(tx, id);
    if (!submission) return null;

    /*
     * Only a record that was actually sent back may be edited here.
     *
     * Anything else reaching this URL is a stale link or a typed address — an
     * approved record is not the worker's to change, and one still waiting is
     * with a supervisor. The server enforces this again in
     * `correctSubmission`; this is so the worker meets a screen rather than a
     * failed send.
     */
    if (submission.status !== 'rejected') return null;

    const version = await loadFormVersionById(tx, submission.formVersionId);
    if (!version) return null;

    return { submission, version };
  });

  if (!loaded) notFound();

  const { submission, version } = loaded;

  return (
    <div className="flex flex-col gap-4 px-5 py-6">
      <Link
        href={`/my-submissions/${submission.id}`}
        className="inline-flex min-h-tap items-center gap-2 self-start text-field-base font-medium text-brand-700"
      >
        <ArrowLeft aria-hidden className="h-5 w-5" />
        {m(session.locale, 'backToList')}
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="text-field-lg font-bold text-slate-900">
          {t(submission.formName, session.locale, submission.formSlug)}
        </h1>
        <p className="text-field-sm text-slate-600">{m(session.locale, 'correctionIntro')}</p>
      </div>

      {/* The reason travels *with* the form, not just on the screen before it.
          A worker part-way through a correction can no longer see why they are
          making it, and scrolling back to find out costs them their place. */}
      {submission.reviewNote ? (
        <div className="rounded-field bg-deny-50 p-4">
          <p className="mb-1 text-field-sm font-semibold text-deny-700">
            {m(session.locale, 'reviewNote')}
          </p>
          <p className="text-field-base text-deny-700">{submission.reviewNote}</p>
        </div>
      ) : null}

      <FormCapture
        version={version}
        locale={session.locale}
        // Both taken from the record. A correction fixes what was written down;
        // it does not move the visit to another person or another place.
        locationId={null}
        subjectId={submission.subjectId}
        subjectName={submission.subjectName}
        /*
         * No duplicate check. That question is "have you registered this person
         * already?", and the answer is plainly yes — this record registered
         * them. Running it would offer to merge somebody with themselves.
         */
        checkDuplicates={false}
        /*
         * No consent step. Permission was asked and recorded when the visit
         * happened; asking again at correction time would append a second
         * attestation for one act, and date it to the day of the typo rather
         * than the day of the encounter.
         */
        consent={null}
        correction={{ submissionId: submission.id, answers: submission.data }}
      />
    </div>
  );
}
