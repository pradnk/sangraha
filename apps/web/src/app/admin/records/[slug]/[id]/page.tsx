import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  getSubmission,
  loadFormVersionById,
  resolveRecordNames,
  type SubmissionDetail,
} from '@sangraha/db';
import { formatAnswers, getFieldType } from '@sangraha/form-engine';
import { requireRole, withSession } from '@/lib/auth/guard';
import { logAccess } from '@/lib/access-log';
import { AnswerList } from '@/components/admin/answer-list';
import { isUuid } from '@/lib/records-filters';
import { ForgetPerson } from './forget-person';
import { t } from '@/lib/i18n';

/**
 * One record, in full.
 *
 * The table upstairs is deliberately narrow — truncated cells, no repeat
 * groups, attachments hidden. This is where the whole thing is readable, and
 * where the ids become links: the person it is about, and any question that
 * points at another person.
 *
 * **Read through `withSession`, not the owner connection.** Unlike the table,
 * which has to read an owner-rights analytics view, a single record comes from
 * `submissions`, where RLS applies. For an org admin `submissions_isolation`
 * reduces to `org_id = app.current_org_id()`, because `is_location_scoped()` is
 * true only for field workers and supervisors. So the tenant boundary here is
 * the policy rather than a hand-written org check, which is the weaker of the
 * two.
 */
export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const session = await requireRole(['org_admin', 'super_admin']);
  const { slug, id } = await params;

  /*
   * Checked before it reaches Postgres. A junk path would otherwise raise
   * `invalid input syntax for type uuid` and become a 500 — an error page that
   * says something is broken, when the honest answer is that there is no such
   * record.
   */
  if (!isUuid(id)) notFound();

  const loaded = await withSession(session, async (tx) => {
    const submission = await getSubmission(tx, id);
    if (!submission) return null;

    /*
     * The record must belong to the form in the URL. Without this,
     * `/admin/records/form-a/<id-from-form-b>` renders form B's record under
     * form A's heading — the same data, filed under the wrong thing, which is
     * worse than a 404 because nothing looks wrong.
     */
    if (submission.formSlug !== slug) return null;

    // The version it was captured under, not today's — an edited form must not
    // change what an old record says.
    const version = await loadFormVersionById(tx, submission.formVersionId);
    if (!version) return null;

    // Every question on this form that points at a person, so their names can
    // be fetched in one go rather than one query per answer.
    const referenced = version.fields
      .filter((field) => getFieldType(field.dataType).referencesSubject)
      .map((field) => submission.data[field.key])
      .filter((value): value is string => typeof value === 'string' && value !== '');

    const names = await resolveRecordNames(tx, session.orgId, {
      subjectIds: referenced,
      userIds: [],
      locationIds: [],
    });

    return { submission, version, names };
  });

  if (!loaded) notFound();

  const { submission, version, names } = loaded;

  await logAccess(session, {
    action: 'view_record',
    targetType: 'submission',
    targetId: submission.id,
    // Named rather than counted: this act exposed exactly one person, and a
    // breach report needs to say which.
    rowCount: 1,
  });

  const answers = formatAnswers(version, submission.data, session.locale, (subjectId) => {
    return names.subject(subjectId)?.displayName ?? null;
  });

  return (
    <div className="flex flex-col gap-5">
      <Link
        href={`/admin/records/${slug}`}
        className="inline-flex items-center gap-2 self-start text-sm font-medium text-brand-700 hover:underline"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Back to {t(submission.formName, session.locale, slug)}
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">
          {t(submission.formName, session.locale, slug)}
        </h1>
        <StatusPill status={submission.status} />
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <Fact label="About">
          {submission.subjectId ? (
            <Link
              href={`/people/${submission.subjectId}`}
              className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
            >
              {submission.subjectName ?? 'View person'}
              <ExternalLink aria-hidden className="h-3 w-3 shrink-0 opacity-60" />
            </Link>
          ) : (
            // Not an omission on a standalone form — it is about nobody.
            <span className="text-slate-400">Not about a specific person</span>
          )}
        </Fact>

        <Fact label="Sent by">{submission.submittedByName ?? <Unknown />}</Fact>

        <Fact label="When">
          {new Intl.DateTimeFormat(`${session.locale}-IN`, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(submission.submittedAt)}
        </Fact>

        <Fact label="Where">
          {submission.locationName ? t(submission.locationName, session.locale) : <Unknown />}
        </Fact>

        {submission.reviewedAt ? (
          <Fact label="Reviewed">
            {submission.reviewedByName ?? 'someone since removed'} ·{' '}
            {new Intl.DateTimeFormat(`${session.locale}-IN`, { dateStyle: 'medium' }).format(
              submission.reviewedAt,
            )}
          </Fact>
        ) : null}

        {submission.reviewNote ? (
          <Fact label="Review note">
            <span className="whitespace-pre-line">{submission.reviewNote}</span>
          </Fact>
        ) : null}
      </dl>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Answers
        </h2>
        <AnswerList answers={answers} />
      </section>

      {/*
       * Here rather than on a compliance screen: this is where somebody is
       * standing when the request reaches them. A rights process three clicks
       * away in a settings menu gets handled by email instead.
       */}
      {submission.subjectId && submission.subjectName ? (
        <ForgetPerson subjectId={submission.subjectId} displayName={submission.subjectName} />
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">{children}</dd>
    </div>
  );
}

/** A worker or place that has since been removed — said, rather than left blank. */
function Unknown() {
  return <span className="text-slate-400">Not recorded</span>;
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'bg-affirm-50 text-affirm-700' },
  submitted: { label: 'Waiting for review', className: 'bg-amber-100 text-amber-800' },
  rejected: { label: 'Sent back', className: 'bg-deny-50 text-deny-700' },
  draft: { label: 'Draft', className: 'bg-slate-100 text-slate-600' },
};

function StatusPill({ status }: { status: SubmissionDetail['status'] }) {
  const style = STATUS_STYLES[status] ?? { label: status, className: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}
