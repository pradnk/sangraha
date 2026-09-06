import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';
import { asc, eq } from 'drizzle-orm';
import {
  countRecords,
  getOwnerDb,
  getRecordView,
  listRecordColumns,
  loadFormVersionDefinitions,
  locations,
  queryRecords,
  resolveRecordNames,
} from '@sangraha/db';
import { describeMainViewColumns } from '@sangraha/form-engine';
import { requireRole, withSession } from '@/lib/auth/guard';
import { logAccess, scopeOf } from '@/lib/access-log';
import { t } from '@/lib/i18n';
import { idsToResolve, planColumns, visibleColumns } from '@/lib/record-columns';
import {
  filtersFromParams,
  filtersToQuery,
  paginationFromParams,
  showTechnicalFromParams,
  type SearchParams,
} from '@/lib/records-filters';
import { RecordsFilters } from './records-filters';
import { RecordsTable } from './records-table';

/**
 * One form's records: counts, filters, a table and a download.
 *
 * Reads the form's generated analytics view rather than the raw JSONB. The view
 * already spans every published version of the form, so a column added in
 * version 3 shows blank for version 1 rows instead of the page having to know
 * anything about versioning.
 *
 * `org_admin` only — see `listRecordViews`.
 */
export default async function RecordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireRole(['org_admin', 'super_admin']);
  const { slug } = await params;
  const query = await searchParams;

  // Resolved under RLS on the request connection, so a slug belonging to
  // another organisation is gone before any owner-rights query runs.
  const loaded = await withSession(session, async (tx) => {
    const view = await getRecordView(tx, session.orgId, slug);
    if (!view) return null;

    const places = await tx
      .select({ id: locations.id, name: locations.name, level: locations.level })
      .from(locations)
      .where(eq(locations.orgId, session.orgId))
      .orderBy(asc(locations.path));

    return { view, places };
  });

  if (!loaded) notFound();

  const { view, places } = loaded;
  const filters = filtersFromParams(query);
  const { page, pageSize } = paginationFromParams(query);
  const showTechnical = showTechnicalFromParams(query);

  const db = getOwnerDb();
  const columns = await listRecordColumns(db, view);
  const counts = await countRecords(db, view, filters);
  const results = await queryRecords(db, view, filters, page, counts.total, pageSize);

  // A page of the register, so the count is what was on screen — not the
  // whole form, which would overstate what this act exposed.
  await logAccess(session, {
    action: 'view_records',
    targetType: 'form',
    targetId: view.formId,
    rowCount: results.rows.length,
    scope: scopeOf(new URLSearchParams(query as Record<string, string>)),
  });

  /*
   * What each column is called, and which question it came from.
   *
   * The descriptor comes from the same function the view generator uses, so a
   * label can never end up against the wrong column — see `GeneratedColumn.source`.
   */
  const described = describeMainViewColumns(
    await loadFormVersionDefinitions(db, view.formId),
    session.locale,
  );
  const plan = planColumns(columns, described, session.locale);

  // One lookup for the whole page, not one per row.
  const names = await resolveRecordNames(db, session.orgId, idsToResolve(plan, results.rows));

  /** Keeps the filters, and whatever of page / size / toggle is not changing. */
  const hrefFor = (next: { page?: number; per?: number; tech?: boolean }) =>
    `/admin/records/${slug}?${filtersToQuery(filters, {
      page: next.page ?? page,
      per: next.per ?? pageSize,
      tech: (next.tech ?? showTechnical) ? '1' : undefined,
    })}`;

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/admin/records"
        className="inline-flex items-center gap-1.5 self-start text-brand-700 hover:underline"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Records
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t(view.formName, session.locale, view.formSlug)}</h1>
          <p className="font-mono text-xs text-slate-400">
            {view.schemaName}.{view.viewName}
          </p>
        </div>

        {/* Carries the current filters, so the file matches the screen. */}
        <a
          href={`/api/exports/${view.formSlug}?${filtersToQuery(filters)}`}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
        >
          <Download aria-hidden className="h-4 w-4" />
          Download spreadsheet
        </a>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Records" value={counts.total} />
        <Stat label="Approved" value={counts.approved} />
        <Stat label="Waiting to be checked" value={counts.awaitingReview} />
        <Stat label="Sent back" value={counts.rejected} />
      </dl>

      <RecordsFilters filters={filters} places={places} locale={session.locale} slug={slug} />

      <RecordsTable
        columns={visibleColumns(plan, results.rows, showTechnical)}
        rows={results.rows}
        names={names}
        slug={slug}
        page={results.page}
        pageCount={results.pageCount}
        pageSize={results.pageSize}
        total={results.total}
        showTechnical={showTechnical}
        locale={session.locale}
        hrefFor={hrefFor}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-2xl font-bold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}
