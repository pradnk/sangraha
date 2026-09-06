/**
 * Deleting a place, and the beneficiaries standing in it.
 *
 * `deleteLocation` refuses when something depends on the place, and the list of
 * what counts as "something" is the whole safety of the operation. It checked
 * child locations and submissions and not the people — so the first two tests
 * here are about the guard, and the third is about why it has to exist, which
 * is a visibility rule two rooms away that nothing about deleting a village
 * would lead you to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database } from '../client';
import { deleteLocation } from '../queries/admin-locations';
import { locations, subjects } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('deleting a place', () => {
  let org: TestOrg;
  let subjectTypeId: string;
  let appClient: postgres.Sql;
  let appDb: Database;

  /** A place with nothing in it, so each test starts from a clean refusal. */
  async function emptyVillage(name: string): Promise<string> {
    const id = randomUUID();
    const [district] = await ownerDb()
      .select({ id: locations.id, path: locations.path })
      .from(locations)
      .where(sql`${locations.orgId} = ${org.id} AND ${locations.parentId} IS NULL`)
      .limit(1);

    await ownerDb().execute(sql`
      INSERT INTO locations (id, org_id, parent_id, name, level, path)
      VALUES (
        ${id}::uuid, ${org.id}, ${district!.id}::uuid,
        ${JSON.stringify({ en: name })}::jsonb, 2,
        (${district!.path}::text || '.' || replace(${id}, '-', '_'))::ltree
      )
    `);
    return id;
  }

  const register = async (name: string, locationId: string | null): Promise<string> => {
    const [person] = await ownerDb()
      .insert(subjects)
      .values({
        orgId: org.id,
        subjectTypeId,
        displayName: name,
        locationId,
        createdBy: org.workerAId,
      })
      .returning({ id: subjects.id });
    return person!.id;
  };

  /** What a field worker confined to village B can actually see. */
  const visibleToWorkerB = async (): Promise<string[]> =>
    appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${org.workerBId}, true)`);
      await tx.execute(sql`select set_config('app.role', 'field_worker', true)`);
      const rows = (await tx.execute(
        sql`select display_name from subjects`,
      )) as unknown as { display_name: string }[];
      return rows.map((row) => row.display_name);
    });

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('places');
    const form = await publishForm(org, 'intake', [{ key: 'note', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['note'],
    });
    subjectTypeId = form.subjectTypeId;
  });

  afterAll(async () => {
    await appClient.end({ timeout: 5 });
    await dropTestOrg(org);
    await closeHarness();
  });

  it('removes a place nothing depends on', async () => {
    const village = await emptyVillage('Nowhere');

    expect(await deleteLocation(ownerDb(), village)).toEqual({ ok: true });

    const left = await ownerDb()
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.id, village));
    expect(left).toHaveLength(0);
  });

  it('refuses while people are registered there, and says how many', async () => {
    /*
     * The check that was missing. `subjects.location_id` is `ON DELETE SET
     * NULL`, so the delete succeeded and took the beneficiaries' recorded place
     * of registration with it — silently, because nothing errors.
     */
    const village = await emptyVillage('Sampgaon');
    await register('Asha', village);

    const result = await deleteLocation(ownerDb(), village);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('1 person is registered here');
      // Offers the thing they actually want, as the sibling refusals do.
      expect(result.reason).toContain('Switch it off');
    }

    const [still] = await ownerDb()
      .select({ locationId: subjects.locationId })
      .from(subjects)
      .where(eq(subjects.displayName, 'Asha'));
    expect(still!.locationId).toBe(village);
  });

  it('would have published them to the whole organisation', async () => {
    /*
     * Why the refusal above matters, demonstrated rather than asserted.
     *
     * `app.can_see_location` returns true when the location is null — correct
     * on its own terms, so that an office-entered record is not invisible to
     * everybody. Combined with `ON DELETE SET NULL` it meant deleting a village
     * made every beneficiary registered in it searchable by every field worker
     * in the organisation, including workers confined to a different district.
     */
    const before = await visibleToWorkerB();
    expect(before).not.toContain('Asha');

    // Exactly what the delete used to do to her row, and nothing else.
    await ownerDb()
      .update(subjects)
      .set({ locationId: null })
      .where(eq(subjects.displayName, 'Asha'));

    expect(await visibleToWorkerB()).toContain('Asha');
  });
});
