'use client';

import { useRouter } from 'next/navigation';
import { FilterX } from 'lucide-react';
import type { I18nText } from '@sangraha/form-engine';
import type { RecordFilters } from '@sangraha/db';
import { localise } from '@sangraha/form-engine';

/**
 * Date range, place and status.
 *
 * A plain GET form rather than client state, so the filters live in the URL:
 * an admin can bookmark a view, send it to a colleague, and the export link
 * picks the same values up without any of them being passed around twice.
 */
export function RecordsFilters({
  filters,
  places,
  locale,
  slug,
}: {
  filters: RecordFilters;
  places: { id: string; name: I18nText; level: number }[];
  locale: string;
  slug: string;
}) {
  const router = useRouter();
  const isFiltered = Boolean(filters.from || filters.to || filters.status || filters.locationId);

  return (
    <form
      // A submit resets to page one: staying on page 7 of a narrower result set
      // usually lands on an empty screen that reads like "no data".
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const params = new URLSearchParams();
        for (const [key, value] of data.entries()) {
          if (typeof value === 'string' && value) params.set(key, value);
        }
        router.push(`/admin/records/${slug}?${params}`);
      }}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">From</span>
        <input
          type="date"
          name="from"
          defaultValue={filters.from ?? ''}
          className="rounded border border-slate-300 px-2 py-1.5"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">To</span>
        <input
          type="date"
          name="to"
          defaultValue={filters.to ?? ''}
          className="rounded border border-slate-300 px-2 py-1.5"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Place</span>
        <select
          name="place"
          defaultValue={filters.locationId ?? ''}
          className="rounded border border-slate-300 px-2 py-1.5"
        >
          <option value="">Everywhere</option>
          {places.map((place) => (
            <option key={place.id} value={place.id}>
              {/* Indented by depth, so the hierarchy is readable in a flat
                  select. Choosing a district includes its villages. */}
              {'  '.repeat(place.level)}
              {localise(place.name, locale, '')}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-600">Status</span>
        <select
          name="status"
          defaultValue={filters.status ?? ''}
          className="rounded border border-slate-300 px-2 py-1.5"
        >
          <option value="">Any</option>
          <option value="submitted">Waiting to be checked</option>
          <option value="approved">Approved</option>
          <option value="rejected">Sent back</option>
        </select>
      </label>

      <button
        type="submit"
        className="rounded-lg bg-slate-800 px-4 py-2 font-medium text-white hover:bg-slate-900"
      >
        Apply
      </button>

      {isFiltered ? (
        <button
          type="button"
          onClick={() => router.push(`/admin/records/${slug}`)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-slate-700 hover:bg-slate-50"
        >
          <FilterX aria-hidden className="h-4 w-4" />
          Clear
        </button>
      ) : null}
    </form>
  );
}
