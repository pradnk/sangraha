import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import {
  countRecordsPerForm,
  countRegisteredPeople,
  listRecordViews,
  type FormRecordCount,
  type RecordView,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';

/**
 * Records — the answer to "can I see my own data without a database client?"
 *
 * A list rather than a grid of cards, because the question this screen exists
 * to answer is "what is in my MIS?" and a card carrying only a name and a slug
 * cannot answer it. A form holding 400 records and one holding none looked
 * identical here; the count and the date of the last record are the whole
 * point of the screen.
 *
 * Restricted to `org_admin`: the analytics views the next screen reads run with
 * owner rights and are not constrained by Row-Level Security, so they return
 * the whole organisation. Supervisors keep the review queue, which is
 * location-scoped.
 */
export default async function RecordsIndexPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const { views, counts, people } = await withSession(session, async (tx) => ({
    views: await listRecordViews(tx, session.orgId),
    counts: await countRecordsPerForm(tx, session.orgId),
    people: await countRegisteredPeople(tx, session.orgId),
  }));

  const rows = views
    .map((view) => ({ view, count: counts.get(view.formId) }))
    // Most recent activity first, and forms with nothing in them last — where a
    // grid put them in the middle looking exactly like the ones with data.
    .sort((a, b) => {
      const left = a.count?.lastRecordAt?.getTime() ?? 0;
      const right = b.count?.lastRecordAt?.getTime() ?? 0;
      if (left !== right) return right - left;
      return a.view.formSlug.localeCompare(b.view.formSlug);
    });

  const totalRecords = rows.reduce((sum, row) => sum + (row.count?.total ?? 0), 0);
  const awaiting = rows.reduce((sum, row) => sum + (row.count?.awaitingReview ?? 0), 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold">Records</h1>
        <p className="mt-1 text-slate-600">
          Everything your team has collected, with filters and a spreadsheet download.
        </p>
      </div>

      {views.length === 0 ? (
        <p className="rounded-lg bg-slate-50 p-6 text-center text-slate-500">
          {/* A view only appears once a form is published, so this is a
              statement about the forms, not about the data. */}
          Nothing to show yet. Publish a form and the records will appear here.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Summary label="Records" value={totalRecords.toLocaleString('en-IN')} />
            <Summary label="People registered" value={people.toLocaleString('en-IN')} />
            <Summary
              label="Waiting for review"
              value={awaiting.toLocaleString('en-IN')}
              muted={awaiting === 0}
            />
          </dl>

          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {rows.map(({ view, count }) => (
              <li key={view.formId}>
                <Link
                  href={`/admin/records/${view.formSlug}`}
                  className="group flex items-center gap-4 px-4 py-3 hover:bg-brand-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {t(view.formName, session.locale, view.formSlug)}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {FORM_TYPE_LABEL[view.formType]}
                    </span>
                  </span>

                  <Count count={count} />

                  <span className="hidden w-40 shrink-0 text-right text-sm text-slate-500 sm:block">
                    {count?.lastRecordAt ? lastAdded(count.lastRecordAt, session.locale) : ''}
                  </span>

                  <ChevronRight
                    aria-hidden
                    className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-brand-600"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** What the form is for, in the words an admin used when they made it. */
const FORM_TYPE_LABEL: Record<RecordView['formType'], string> = {
  registration: 'Registers a person',
  encounter: 'Records a visit',
  standalone: 'One-off form',
};

function Summary({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 text-2xl font-semibold tabular-nums ${
          muted ? 'text-slate-300' : 'text-slate-900'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Count({ count }: { count: FormRecordCount | undefined }) {
  const total = count?.total ?? 0;

  if (total === 0) {
    // Said plainly rather than shown as a zero. An admin looking for missing
    // data needs to know the form is empty, not squint at a number.
    return <span className="shrink-0 text-sm text-slate-400">No records yet</span>;
  }

  return (
    <span className="shrink-0 text-right">
      <span className="block font-semibold tabular-nums">{total.toLocaleString('en-IN')}</span>
      {count!.awaitingReview > 0 ? (
        <span className="block text-xs text-amber-700">{count!.awaitingReview} waiting</span>
      ) : null}
    </span>
  );
}

/** Recency in the terms somebody thinks in — "today", not a timestamp. */
function lastAdded(at: Date, locale: string): string {
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);

  if (days <= 0) return 'Added today';
  if (days === 1) return 'Added yesterday';
  if (days < 30) return `Added ${days} days ago`;

  return `Added ${new Intl.DateTimeFormat(`${locale}-IN`, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(at)}`;
}
