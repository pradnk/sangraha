import { and, eq, inArray } from 'drizzle-orm';
import type { I18nText } from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { locations, users } from '../schema/tenancy';
import { subjects } from '../schema/data';

/**
 * Turning the uuids in a page of records into names.
 *
 * A generated view carries ids and nothing else: `subject_id`, `submitted_by`,
 * `location_id`, and a uuid for every "link to a person" question. Rendered as
 * they are, a Records table is a wall of `b8b9cf9f-…` and the registry sitting
 * behind those ids might as well not exist.
 *
 * Load-once, resolve-many, after `subjectDetailResolver`: the caller collects
 * the ids a page needs, this issues at most one query per table, and the
 * returned lookups are synchronous. Never a query per row.
 *
 * **The `orgId` filter on every query is the security boundary here, not a
 * convenience.** `getRecordView` checks that the *view* belongs to the caller;
 * it says nothing about ids read out of one, and the table is read on the owner
 * connection where RLS does not apply. A stale or cross-tenant uuid sitting in
 * a jsonb answer would otherwise resolve to another organisation's
 * beneficiary's name. An id that does not resolve comes back `null`.
 */

export interface RecordNames {
  subject(id: unknown): { id: string; displayName: string } | null;
  user(id: unknown): string | null;
  location(id: unknown): I18nText | null;
}

export interface RecordNameIds {
  subjectIds: string[];
  userIds: string[];
  locationIds: string[];
}

/**
 * Postgres refuses a statement with more than 65,535 parameters.
 *
 * A page of 500 with three uuid columns is 1,500 binds — well inside it, but
 * the ceiling is a property of the driver rather than of any page size we
 * happen to offer today, so it is enforced here instead of assumed.
 */
const CHUNK = 1000;

async function inChunks<T>(
  ids: string[],
  load: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  if (ids.length <= CHUNK) return load(ids);

  const results: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    results.push(...(await load(ids.slice(i, i + CHUNK))));
  }
  return results;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * De-duplicates, and drops anything that is not a uuid.
 *
 * These ids come out of jsonb answers and a bulk import can put anything there.
 * A non-uuid reaching `inArray` raises `invalid input syntax for type uuid`,
 * which is a 500 on the whole page — every record unreadable because one cell
 * held a name. Dropped here, it costs that one cell its link.
 */
const unique = (ids: string[]): string[] => [
  ...new Set(ids.filter((id) => typeof id === 'string' && UUID.test(id))),
];

export async function resolveRecordNames(
  db: DbLike,
  orgId: string,
  ids: RecordNameIds,
): Promise<RecordNames> {
  const subjectIds = unique(ids.subjectIds);
  const userIds = unique(ids.userIds);
  const locationIds = unique(ids.locationIds);

  // Each query is skipped outright when there is nothing to look up — the
  // common case for a standalone form is one query, not three.
  const [subjectRows, userRows, locationRows] = await Promise.all([
    inChunks(subjectIds, (batch) =>
      db
        .select({ id: subjects.id, displayName: subjects.displayName })
        .from(subjects)
        .where(and(eq(subjects.orgId, orgId), inArray(subjects.id, batch))),
    ),
    inChunks(userIds, (batch) =>
      db
        .select({ id: users.id, fullName: users.fullName })
        .from(users)
        .where(and(eq(users.orgId, orgId), inArray(users.id, batch))),
    ),
    inChunks(locationIds, (batch) =>
      db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(and(eq(locations.orgId, orgId), inArray(locations.id, batch))),
    ),
  ]);

  const subjectsById = new Map(subjectRows.map((row) => [row.id, row]));
  const usersById = new Map(userRows.map((row) => [row.id, row.fullName]));
  const locationsById = new Map(locationRows.map((row) => [row.id, row.name]));

  const key = (id: unknown): string | null => (typeof id === 'string' && id !== '' ? id : null);

  return {
    subject: (id) => {
      const found = key(id);
      const row = found ? subjectsById.get(found) : undefined;
      return row ? { id: row.id, displayName: row.displayName } : null;
    },
    user: (id) => {
      const found = key(id);
      return (found ? usersById.get(found) : undefined) ?? null;
    },
    location: (id) => {
      const found = key(id);
      return (found ? locationsById.get(found) : undefined) ?? null;
    },
  };
}
