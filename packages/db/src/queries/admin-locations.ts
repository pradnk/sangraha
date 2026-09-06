import { asc, eq, sql } from 'drizzle-orm';
import type { I18nText } from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { locations, organisations, userLocations } from '../schema/tenancy';
import { subjects, submissions } from '../schema/data';
import { toLtreeLabel } from '../schema/_shared';

/**
 * The location hierarchy.
 *
 * Depth and the name of each level are per-organisation: an education NGO uses
 * district → block → school, a health one district → block → village. The
 * `ltree` path on each row is what makes "everything under this block" a single
 * indexed lookup, and it is also what the supervisor Row-Level Security policy
 * relies on — so it has to stay consistent with `parent_id`.
 */

export interface LocationNode {
  id: string;
  parentId: string | null;
  name: I18nText;
  level: number;
  path: string;
  externalCode: string | null;
  isActive: boolean;
  /** True when something references it, so the UI can refuse a delete. */
  inUse: boolean;
}

export async function listLocations(db: DbLike, orgId: string): Promise<LocationNode[]> {
  const rows = await db
    .select({
      id: locations.id,
      parentId: locations.parentId,
      name: locations.name,
      level: locations.level,
      path: locations.path,
      externalCode: locations.externalCode,
      isActive: locations.isActive,
    })
    .from(locations)
    .where(eq(locations.orgId, orgId))
    // Ordering by path yields a depth-first tree, so the UI can render it by
    // indenting on `level` without building the tree itself.
    .orderBy(asc(locations.path));

  if (rows.length === 0) return [];

  const [assigned, withSubjects, withSubmissions, withChildren] = await Promise.all([
    db.select({ id: userLocations.locationId }).from(userLocations),
    db.select({ id: subjects.locationId }).from(subjects).where(eq(subjects.orgId, orgId)),
    db.select({ id: submissions.locationId }).from(submissions).where(eq(submissions.orgId, orgId)),
    db.select({ id: locations.parentId }).from(locations).where(eq(locations.orgId, orgId)),
  ]);

  const used = new Set<string>(
    [...assigned, ...withSubjects, ...withSubmissions, ...withChildren]
      .map((r) => r.id)
      .filter((id): id is string => id !== null),
  );

  return rows.map((row) => ({ ...row, inUse: used.has(row.id) }));
}

export interface LocationLevel {
  key: string;
  label: Record<string, string>;
}

export async function getLocationLevels(db: DbLike, orgId: string): Promise<LocationLevel[]> {
  const [org] = await db
    .select({ levels: organisations.locationLevels })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  return org?.levels ?? [];
}

/**
 * Adds a place beneath an optional parent.
 *
 * The path is composed from the parent's, so containment queries keep working
 * without a recursive walk. Ids are generated here rather than by the database
 * because the path has to embed this row's own id.
 */
export async function addLocation(
  db: DbLike,
  orgId: string,
  input: { parentId: string | null; name: I18nText; externalCode?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  let level = 0;
  let path = toLtreeLabel(id);

  if (input.parentId) {
    const [parent] = await db
      .select({ path: locations.path, level: locations.level })
      .from(locations)
      .where(eq(locations.id, input.parentId))
      .limit(1);
    if (!parent) throw new Error('Parent location not found');
    level = parent.level + 1;
    path = `${parent.path}.${toLtreeLabel(id)}`;
  }

  await db.insert(locations).values({
    id,
    orgId,
    parentId: input.parentId,
    name: input.name,
    level,
    path,
    externalCode: input.externalCode ?? null,
  });

  return id;
}

/** Renames a place. The path and therefore every scope stays as it was. */
export async function renameLocation(
  db: DbLike,
  id: string,
  name: I18nText,
  externalCode?: string | null,
): Promise<void> {
  await db
    .update(locations)
    .set({ name, externalCode: externalCode ?? null, updatedAt: new Date() })
    .where(eq(locations.id, id));
}

export async function setLocationActive(
  db: DbLike,
  id: string,
  isActive: boolean,
): Promise<void> {
  await db.update(locations).set({ isActive, updatedAt: new Date() }).where(eq(locations.id, id));
}

export type DeleteLocationResult = { ok: true } | { ok: false; reason: string };

/**
 * Deletes a place, or refuses because something depends on it.
 *
 * Refusing is usually right: a place attached to submissions is part of where
 * the data came from, and removing it would strand records with no location.
 * Deactivating keeps history intact and stops it being offered.
 */
export async function deleteLocation(db: DbLike, id: string): Promise<DeleteLocationResult> {
  const [children] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(locations)
    .where(eq(locations.parentId, id));
  if ((children?.total ?? 0) > 0) {
    return { ok: false, reason: 'This place has others inside it. Remove those first.' };
  }

  const [used] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(submissions)
    .where(eq(submissions.locationId, id));
  if ((used?.total ?? 0) > 0) {
    return {
      ok: false,
      reason: `${used!.total} record${used!.total === 1 ? '' : 's'} came from this place. Switch it off instead — it stops being offered, and the records keep their location.`,
    };
  }

  /*
   * People registered here, which is the check that was missing and the one
   * with teeth.
   *
   * `subjects.location_id` is `ON DELETE SET NULL`, and `app.can_see_location`
   * treats a null location as visible org-wide — deliberately, so that an
   * office-entered record is not invisible to everyone. Together those two
   * correct decisions meant deleting a village quietly published every
   * beneficiary registered in it to every field worker in the organisation,
   * and destroyed their recorded place of registration on the way.
   */
  const [registered] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(subjects)
    .where(eq(subjects.locationId, id));
  if ((registered?.total ?? 0) > 0) {
    return {
      ok: false,
      reason: `${registered!.total} ${registered!.total === 1 ? 'person is' : 'people are'} registered here. Switch it off instead — it stops being offered, and they stay where they were registered.`,
    };
  }

  await db.delete(userLocations).where(eq(userLocations.locationId, id));
  await db.delete(locations).where(eq(locations.id, id));
  return { ok: true };
}

export interface OrgSettings {
  name: string;
  slug: string;
  defaultLocale: string;
  enabledLocales: string[];
  locationLevels: LocationLevel[];
}

export async function getOrgSettings(db: DbLike, orgId: string): Promise<OrgSettings | null> {
  const [org] = await db
    .select({
      name: organisations.name,
      slug: organisations.slug,
      defaultLocale: organisations.defaultLocale,
      enabledLocales: organisations.enabledLocales,
      locationLevels: organisations.locationLevels,
    })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);

  return org ?? null;
}

/**
 * Updates organisation settings.
 *
 * `slug` is deliberately not editable: it names the analytics schema and the
 * login URL, and renaming it would orphan every generated view.
 */
export async function updateOrgSettings(
  db: DbLike,
  orgId: string,
  patch: {
    name?: string;
    defaultLocale?: string;
    enabledLocales?: string[];
    locationLevels?: LocationLevel[];
  },
): Promise<void> {
  await db
    .update(organisations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(organisations.id, orgId));
}
