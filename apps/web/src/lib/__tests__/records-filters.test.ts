/**
 * Reading the Records URL.
 *
 * The load-bearing property is a separation: `filtersFromParams` is shared with
 * the CSV export route, and `paginationFromParams` is not. If a page size ever
 * leaks into the first one, the download silently returns one screenful — a
 * file that looks complete, opens fine, and is missing most of the data.
 */
import { describe, expect, it } from 'vitest';
import {
  filtersFromParams,
  filtersToQuery,
  isUuid,
  paginationFromParams,
  showTechnicalFromParams,
} from '../records-filters';

const params = (query: string) => new URLSearchParams(query);

describe('filters', () => {
  it('reads what it recognises', () => {
    const filters = filtersFromParams(
      params('from=2026-01-01&to=2026-02-01&status=approved&place=0a3f1e2b-1111-4222-8333-444455556666'),
    );

    expect(filters).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
      status: 'approved',
      locationId: '0a3f1e2b-1111-4222-8333-444455556666',
    });
  });

  it('drops what it does not', () => {
    // A hand-edited URL should narrow to nothing, not error.
    const filters = filtersFromParams(params('from=yesterday&status=maybe&place=nope'));
    expect(filters).toEqual({ from: null, to: null, status: null, locationId: null });
  });

  it('never carries a page size, however the URL is written', () => {
    /*
     * The regression this file exists for. `filtersFromParams` feeds the export,
     * so anything it returns can end up bounding the download.
     */
    const filters = filtersFromParams(params('per=50&page=3&tech=1&status=approved'));

    expect(filters).toEqual({ from: null, to: null, status: 'approved', locationId: null });
    expect(JSON.stringify(filters)).not.toContain('50');
    expect(Object.keys(filters).sort()).toEqual(['from', 'locationId', 'status', 'to']);
  });

  it('builds an export link with the filters and nothing else', () => {
    // This is exactly the call the Download button makes.
    const query = filtersToQuery(filtersFromParams(params('per=500&page=7&status=approved')));

    expect(query).toBe('status=approved');
    expect(query).not.toContain('per');
    expect(query).not.toContain('page');
  });
});

describe('pagination', () => {
  it('reads the page and size', () => {
    expect(paginationFromParams(params('page=3&per=250'))).toEqual({ page: 3, pageSize: 250 });
  });

  it('defaults to the first page at the smallest size', () => {
    expect(paginationFromParams(params(''))).toEqual({ page: 1, pageSize: 50 });
  });

  it('refuses a size nobody offered, and a nonsense page', () => {
    expect(paginationFromParams(params('per=1000000')).pageSize).toBe(50);
    expect(paginationFromParams(params('per=17')).pageSize).toBe(50);
    expect(paginationFromParams(params('page=0')).page).toBe(1);
    expect(paginationFromParams(params('page=-4')).page).toBe(1);
    expect(paginationFromParams(params('page=abc')).page).toBe(1);
  });
});

describe('the technical toggle', () => {
  it('is off unless asked for', () => {
    expect(showTechnicalFromParams(params(''))).toBe(false);
    expect(showTechnicalFromParams(params('tech=0'))).toBe(false);
    expect(showTechnicalFromParams(params('tech=1'))).toBe(true);
  });
});

describe('isUuid', () => {
  it('accepts a uuid and rejects a path somebody typed', () => {
    // Exported so a route can answer 404 instead of letting Postgres raise
    // `invalid input syntax for type uuid` and returning a 500.
    expect(isUuid('0a3f1e2b-1111-4222-8333-444455556666')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
