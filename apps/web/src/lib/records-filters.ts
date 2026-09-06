import { RECORD_STATUSES, clampPageSize, type RecordFilters } from '@sangraha/db';

/**
 * Reads the record filters out of a query string.
 *
 * Shared by the Records screen and the export route so the two cannot drift —
 * a download that silently applies different filters from the table above it is
 * worse than no download at all.
 */
export function filtersFromParams(params: URLSearchParams | SearchParams): RecordFilters {
  const get = (key: string): string | null => {
    if (params instanceof URLSearchParams) return params.get(key);
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };

  const status = get('status');

  return {
    from: isDate(get('from')) ? get('from') : null,
    to: isDate(get('to')) ? get('to') : null,
    // An unrecognised status is dropped rather than passed through, so a
    // hand-edited URL narrows to nothing instead of erroring.
    status: status && (RECORD_STATUSES as readonly string[]).includes(status) ? status : null,
    locationId: isUuid(get('place')) ? get('place') : null,
  };
}

/** Re-serialises filters into a link, dropping the ones that are not set. */
export function filtersToQuery(
  filters: RecordFilters,
  extra: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.status) params.set('status', filters.status);
  if (filters.locationId) params.set('place', filters.locationId);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

/**
 * Which page, and how big.
 *
 * Deliberately separate from `filtersFromParams`. That one is shared with the
 * CSV export route, and a page size leaking into it would mean a download that
 * quietly returns fifty rows — a file that looks complete and is not. Keeping
 * the two apart is what makes that impossible rather than merely unlikely.
 */
export function paginationFromParams(
  params: URLSearchParams | SearchParams,
): { page: number; pageSize: number } {
  const get = (key: string): string | null => {
    if (params instanceof URLSearchParams) return params.get(key);
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };

  const page = Number(get('page') ?? '1');

  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    // Clamped again in `queryRecords`; a hand-edited `?per=100000` should not
    // be a resource question that depends on the caller having sanitised it.
    pageSize: clampPageSize(get('per')),
  };
}

/** True when the admin asked to see the ids and timestamps. */
export function showTechnicalFromParams(params: URLSearchParams | SearchParams): boolean {
  const value = params instanceof URLSearchParams ? params.get('tech') : params.tech;
  return (Array.isArray(value) ? value[0] : value) === '1';
}

export type SearchParams = Record<string, string | string[] | undefined>;

export const isDate = (value: string | null): boolean => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));

/** Exported so a route can reject a junk id with a 404 rather than a 500. */
export const isUuid = (value: string | null): boolean =>
  Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
