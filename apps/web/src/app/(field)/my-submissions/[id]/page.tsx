import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getSubmission, loadFormVersionById } from '@sangraha/db';
import { formatAnswers } from '@sangraha/form-engine';
import { requireSession, withSession } from '@/lib/auth/guard';
import { subjectNameLookup } from '@/lib/subject-names';
import { AnswerList } from '@/components/field/answer-list';
import { StatusBadge } from '@/components/field/status-badge';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';

export default async function SubmissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const loaded = await withSession(session, async (tx) => {
    // Out of scope resolves to null rather than a 403: the RLS policy filters
    // the row out, so as far as this worker is concerned it does not exist.
    const submission = await getSubmission(tx, id);
    if (!submission) return null;

    // Rendered against the version it was captured under, not the current one,
    // so a later edit to the form cannot change what this record appears to say.
    const version = await loadFormVersionById(tx, submission.formVersionId);
    if (!version) return null;

    // So a "link to a person" answer reads as their name rather than a uuid.
    const nameOf = await subjectNameLookup(tx, session.orgId, [
      { version, data: submission.data },
    ]);

    return { submission, version, nameOf };
  });

  if (!loaded) notFound();

  const { submission, version, nameOf } = loaded;
  const answers = formatAnswers(version, submission.data, session.locale, nameOf);

  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      <Link
        href="/my-submissions"
        className="inline-flex min-h-tap items-center gap-2 self-start text-field-base font-medium text-brand-700"
      >
        <ArrowLeft aria-hidden className="h-5 w-5" />
        {m(session.locale, 'backToList')}
      </Link>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-field-lg font-bold text-slate-900">
            {t(submission.formName, session.locale, submission.formSlug)}
          </h1>
          <StatusBadge status={submission.status} locale={session.locale} />
        </div>
        {submission.subjectName ? (
          <p className="text-field-base text-slate-700">{submission.subjectName}</p>
        ) : null}
        <p className="text-field-sm text-slate-500">
          {m(session.locale, 'submittedOn')}{' '}
          {new Intl.DateTimeFormat(`${session.locale}-IN`, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(submission.submittedAt)}
        </p>
      </div>

      {/* A rejection is only actionable if the reason travels with it. */}
      {submission.status === 'rejected' && submission.reviewNote ? (
        <div className="rounded-field bg-deny-50 p-4">
          <p className="mb-1 text-field-sm font-semibold text-deny-700">
            {m(session.locale, 'reviewNote')}
          </p>
          <p className="text-field-base text-deny-700">{submission.reviewNote}</p>
        </div>
      ) : null}

      <AnswerList answers={answers} locale={session.locale} />
    </div>
  );
}
