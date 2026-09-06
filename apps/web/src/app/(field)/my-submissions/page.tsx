import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { listSubmissions, loadFormVersionById } from '@sangraha/db';
import { summariseSubmission } from '@sangraha/form-engine';
import { requireSession, withSession } from '@/lib/auth/guard';
import { subjectNameLookup } from '@/lib/subject-names';
import { StatusBadge } from '@/components/field/status-badge';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';

/**
 * What this worker has sent.
 *
 * Asked for by name, rather than left to Row-Level Security. The policy does
 * restrict a `field_worker` to their own rows — but only a field worker, so a
 * supervisor or an admin opening this page was shown every record in their
 * whole subtree under a heading that says "my". The policies remain the tenant
 * and location boundary; this narrows inside it.
 */
export default async function MySubmissionsPage() {
  const session = await requireSession();

  const rows = await withSession(session, async (tx) => {
    const submissions = await listSubmissions(tx, { submittedBy: session.userId, limit: 50 });

    // Each row is summarised through its own form version, so a record captured
    // before a question was renamed still reads correctly.
    const versions = new Map(
      await Promise.all(
        [...new Set(submissions.map((s) => s.formVersionId))].map(
          async (id) => [id, await loadFormVersionById(tx, id)] as const,
        ),
      ),
    );

    // Names for the whole page in one query, so a summary line reads
    // "Sunita Devi" and not "b8b9cf9f-…".
    const nameOf = await subjectNameLookup(
      tx,
      session.orgId,
      submissions.map((s) => ({ version: versions.get(s.formVersionId) ?? undefined, data: s.data })),
    );

    return submissions.map((submission) => {
      const version = versions.get(submission.formVersionId);
      return {
        ...submission,
        summary: version
          ? summariseSubmission(version, submission.data, session.locale, 2, nameOf)
          : '',
      };
    });
  });

  return (
    <div className="flex flex-col gap-3 px-5 py-6">
      <h1 className="text-field-lg font-bold text-slate-900">
        {m(session.locale, 'mySubmissions')}
      </h1>

      {rows.length === 0 ? (
        <p className="rounded-field bg-slate-100 p-5 text-field-base text-slate-700">
          {m(session.locale, 'submissionsEmpty')}
        </p>
      ) : null}

      {rows.map((row) => (
        <Link
          key={row.id}
          href={`/my-submissions/${row.id}`}
          className="flex min-h-tap-lg items-center gap-3 rounded-field border-2 border-slate-200 bg-white px-4 py-3"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-field-base font-semibold text-slate-900">
              {row.subjectName ?? t(row.formName, session.locale, row.formSlug)}
            </span>
            {row.summary ? (
              <span className="truncate text-field-sm text-slate-600">{row.summary}</span>
            ) : null}
            <span className="text-field-sm text-slate-500">
              {formatDate(row.submittedAt, session.locale)}
            </span>
          </span>
          <StatusBadge status={row.status} locale={session.locale} />
          <ChevronRight aria-hidden className="h-5 w-5 shrink-0 text-slate-400" />
        </Link>
      ))}
    </div>
  );
}

/** Localised and abbreviated — a full timestamp is noise on a list row. */
function formatDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(`${locale}-IN`, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}
