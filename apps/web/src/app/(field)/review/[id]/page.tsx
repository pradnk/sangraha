import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import {
  consentRecordFor,
  formNeedsConsent,
  getSubmission,
  loadFormVersionById,
} from '@sangraha/db';
import { formatAnswers } from '@sangraha/form-engine';
import { requireRole, withSession } from '@/lib/auth/guard';
import { subjectNameLookup } from '@/lib/subject-names';
import { AnswerList } from '@/components/field/answer-list';
import { ConsentRecordPanel } from '@/components/field/consent-record';
import { StatusBadge } from '@/components/field/status-badge';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';
import { ReviewActions } from './review-actions';

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRole(['supervisor', 'org_admin']);
  const { id } = await params;

  const loaded = await withSession(session, async (tx) => {
    const submission = await getSubmission(tx, id);
    if (!submission) return null;
    const version = await loadFormVersionById(tx, submission.formVersionId);
    if (!version) return null;

    // A reviewer deciding on a record must be able to read every answer in it,
    // and a uuid is not something anyone can check.
    const nameOf = await subjectNameLookup(tx, session.orgId, [
      { version, data: submission.data },
    ]);

    /*
     * The permission behind the record, not just the answers in it.
     *
     * A supervisor approving the registration of a child could previously not
     * see that a child was involved, nor whether anybody agreed on their behalf.
     * Both were recorded all along.
     */
    const consent = submission.subjectId
      ? await consentRecordFor(tx, session.orgId, submission.subjectId)
      : [];
    const consentNeeded = await formNeedsConsent(tx, session.orgId, version.id);

    return { submission, version, nameOf, consent, consentNeeded };
  });

  if (!loaded) notFound();

  const { submission, version, nameOf, consent, consentNeeded } = loaded;
  const answers = formatAnswers(version, submission.data, session.locale, nameOf);

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col gap-5 px-5 py-6">
        <Link
          href="/review"
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
            {m(session.locale, 'submittedBy')} {submission.submittedByName ?? '—'} ·{' '}
            {new Intl.DateTimeFormat(`${session.locale}-IN`, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(submission.submittedAt)}
          </p>
          {submission.locationName ? (
            <p className="text-field-sm text-slate-500">
              {t(submission.locationName, session.locale)}
            </p>
          ) : null}
        </div>

        {/* Above the answers, because whether this person agreed to give them
            decides whether the answers may be kept at all. */}
        <ConsentRecordPanel
          records={consent}
          consentNeeded={consentNeeded}
          locale={session.locale}
        />

        <AnswerList answers={answers} locale={session.locale} />
      </div>

      {/* Decisions are only offered while the record is still awaiting one. */}
      {submission.status === 'submitted' ? (
        <ReviewActions submissionId={submission.id} locale={session.locale} />
      ) : null}
    </div>
  );
}
