import Link from 'next/link';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { RecordNames } from '@sangraha/db';
import { localise } from '@sangraha/form-engine';
import type { DisplayColumn } from '@/lib/record-columns';
import { RecordsPager } from './records-pager';

/**
 * A form's records.
 *
 * Columns arrive already sorted and labelled by `planColumns`, so this file
 * decides only how a value looks. The ids are the point of the rest of it: a
 * `subject_id` is a person, and rendering it as `b8b9cf9f-…` puts the registry
 * one unusable column away from the records that belong to it.
 */
export function RecordsTable({
  columns,
  rows,
  names,
  slug,
  page,
  pageCount,
  pageSize,
  total,
  showTechnical,
  locale,
  hrefFor,
}: {
  columns: DisplayColumn[];
  rows: Record<string, unknown>[];
  names: RecordNames;
  slug: string;
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  showTechnical: boolean;
  locale: string;
  hrefFor: (params: { page?: number; per?: number; tech?: boolean }) => string;
}) {
  if (total === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
          No records match these filters.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Showing <strong>{(page - 1) * pageSize + 1}</strong>–
          <strong>{Math.min(page * pageSize, total)}</strong> of <strong>{total}</strong>
        </p>

        {/*
         * A link, not a checkbox: which columns are rendered is decided on the
         * server. Hiding them in CSS would still ship every id and timestamp to
         * the browser, throwing the saving away exactly at the page size where
         * it matters.
         */}
        <Link
          href={hrefFor({ tech: !showTechnical, page: 1 })}
          className="text-sm text-brand-700 hover:underline"
        >
          {showTechnical ? 'Hide technical columns' : 'Show technical columns'}
        </Link>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full border-collapse bg-white text-sm">
          <thead className="bg-slate-50">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.name}
                  scope="col"
                  className={`whitespace-nowrap border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold ${
                    column.group === 'technical'
                      ? 'font-mono text-slate-400'
                      : 'uppercase tracking-wide text-slate-600'
                  }`}
                >
                  {column.label}
                </th>
              ))}
              <th scope="col" className="w-10 border-b border-slate-200" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const id = String(row.submission_id ?? index);
              return (
                <tr key={id} className="group even:bg-slate-50/60 hover:bg-brand-50/50">
                  {columns.map((column) => (
                    <td
                      key={column.name}
                      className="max-w-xs truncate whitespace-nowrap border-b border-slate-100 px-3 py-2 text-slate-800"
                    >
                      <Cell column={column} value={row[column.name]} names={names} locale={locale} />
                    </td>
                  ))}
                  <td className="border-b border-slate-100 px-2 py-2">
                    <Link
                      href={`/admin/records/${slug}/${id}`}
                      aria-label="Open this record"
                      className="inline-flex text-slate-300 group-hover:text-brand-600"
                    >
                      <ChevronRight aria-hidden className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <RecordsPager
        page={page}
        pageCount={pageCount}
        pageSize={pageSize}
        hrefFor={hrefFor}
      />
    </div>
  );
}

function Cell({
  column,
  value,
  names,
  locale,
}: {
  column: DisplayColumn;
  value: unknown;
  names: RecordNames;
  locale: string;
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-slate-300">—</span>;
  }

  switch (column.kind) {
    case 'person': {
      const person = names.subject(value);
      // An id that resolves to nobody stays an id rather than becoming a name
      // that is not theirs — see `resolveRecordNames`.
      if (!person) return <Raw value={value} />;
      return (
        <Link
          href={`/people/${person.id}`}
          className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
        >
          {person.displayName}
          <ExternalLink aria-hidden className="h-3 w-3 shrink-0 opacity-60" />
        </Link>
      );
    }

    case 'user':
      return <>{names.user(value) ?? <Raw value={value} />}</>;

    case 'place': {
      const place = names.location(value);
      return <>{place ? localise(place, locale, '') : <Raw value={value} />}</>;
    }

    case 'status':
      return <StatusPill status={String(value)} />;

    case 'boolean':
      return <>{value === true ? 'Yes' : value === false ? 'No' : <Raw value={value} />}</>;

    case 'date':
      return <>{formatDate(value, locale)}</>;

    case 'datetime':
      return <>{formatDateTime(value, locale)}</>;

    case 'choices': {
      if (!Array.isArray(value)) return <Raw value={value} />;
      const labels = value.map((code) => column.options?.get(String(code)) ?? String(code));
      return <span title={labels.join(', ')}>{labels.join(', ')}</span>;
    }

    default:
      return <Raw value={value} />;
  }
}

/** Anything with no better rendering, including an id that did not resolve. */
function Raw({ value }: { value: unknown }) {
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  return (
    <span className="font-mono text-xs text-slate-500" title={text}>
      {text}
    </span>
  );
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'bg-affirm-50 text-affirm-700' },
  submitted: { label: 'Waiting', className: 'bg-amber-100 text-amber-800' },
  rejected: { label: 'Sent back', className: 'bg-deny-50 text-deny-700' },
};

function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLES[status];
  if (!style) return <Raw value={status} />;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}

function formatDate(value: unknown, locale: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(`${locale}-IN`, { dateStyle: 'medium' }).format(date);
}

function formatDateTime(value: unknown, locale: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(`${locale}-IN`, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
