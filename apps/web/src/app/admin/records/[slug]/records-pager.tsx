import Link from 'next/link';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { RECORD_PAGE_SIZES } from '@sangraha/db';

/**
 * Moving through the pages, and choosing how big they are.
 *
 * Two chevrons and nothing else was fine at four pages and useless at forty:
 * reaching page 30 meant clicking Next thirty times, and there was no way to
 * see how far in you were. Numbers with an ellipsis fit any length in the same
 * width.
 */
export function RecordsPager({
  page,
  pageCount,
  pageSize,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  hrefFor: (params: { page?: number; per?: number; tech?: boolean }) => string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm text-slate-600">
        Show
        {/*
         * Links rather than a select, so this works before hydration and the
         * page size lives in the URL — a view an admin can bookmark or send to
         * a colleague.
         */}
        <span className="inline-flex overflow-hidden rounded-lg border border-slate-300">
          {RECORD_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              // Back to page one: staying on page 7 of a bigger page size
              // usually lands past the end.
              href={hrefFor({ per: size, page: 1 })}
              aria-current={size === pageSize ? 'true' : undefined}
              className={`px-2.5 py-1 tabular-nums ${
                size === pageSize
                  ? 'bg-brand-600 font-medium text-white'
                  : 'bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {size}
            </Link>
          ))}
        </span>
        at a time
      </label>

      {pageCount > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-1">
          <Step href={hrefFor({ page: 1 })} disabled={page <= 1} label="First page">
            <ChevronsLeft aria-hidden className="h-4 w-4" />
          </Step>
          <Step href={hrefFor({ page: page - 1 })} disabled={page <= 1} label="Previous page">
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </Step>

          {pageNumbers(page, pageCount).map((entry, index) =>
            entry === null ? (
              <span key={`gap-${index}`} className="px-1 text-slate-400">
                …
              </span>
            ) : (
              <Link
                key={entry}
                href={hrefFor({ page: entry })}
                aria-current={entry === page ? 'page' : undefined}
                className={`min-w-8 rounded border px-2 py-1 text-center text-sm tabular-nums ${
                  entry === page
                    ? 'border-brand-600 bg-brand-600 font-medium text-white'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {entry}
              </Link>
            ),
          )}

          <Step
            href={hrefFor({ page: page + 1 })}
            disabled={page >= pageCount}
            label="Next page"
          >
            <ChevronRight aria-hidden className="h-4 w-4" />
          </Step>
          <Step href={hrefFor({ page: pageCount })} disabled={page >= pageCount} label="Last page">
            <ChevronsRight aria-hidden className="h-4 w-4" />
          </Step>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * Which page numbers to show: always the first and last, and a window around
 * where you are. `null` is an ellipsis.
 */
export function pageNumbers(page: number, pageCount: number): (number | null)[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);

  const window = new Set([1, pageCount, page, page - 1, page + 1]);
  // Keep the row a constant width near the ends, where the window is clipped.
  if (page <= 3) [2, 3, 4].forEach((n) => window.add(n));
  if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((n) => window.add(n));

  const pages = [...window].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);

  const withGaps: (number | null)[] = [];
  let previous = 0;
  for (const current of pages) {
    // An ellipsis standing for exactly one page is worse than the page: same
    // width, no longer clickable. Spell it out instead.
    if (previous && current - previous === 2) withGaps.push(previous + 1);
    else if (previous && current - previous > 2) withGaps.push(null);
    withGaps.push(current);
    previous = current;
  }
  return withGaps;
}

function Step({
  href,
  disabled,
  label,
  children,
}: {
  href: string;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled
        aria-label={label}
        className="inline-flex rounded border border-slate-200 px-2 py-1 text-slate-300"
      >
        {children}
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
    >
      {children}
    </Link>
  );
}
