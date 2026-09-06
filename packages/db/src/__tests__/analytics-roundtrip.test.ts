/**
 * Round-trip: data written through the application comes back out of the
 * analytics views as correctly typed relational rows.
 *
 * This is the claim the whole storage design rests on — flexible JSONB in,
 * clean analytics out — so it is verified against a real Postgres rather than
 * asserted about generated SQL strings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pgIdentifier } from '@sangraha/form-engine';
import { regenerateFormViews } from '../analytics/generate';
import { formVersions, submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('analytics round-trip', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('roundtrip');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  const readView = async (view: string) => {
    const result = await ownerDb().execute(
      sql.raw(
        `SELECT * FROM ${pgIdentifier(org.analyticsSchema)}.${pgIdentifier(view)} ORDER BY submitted_at`,
      ),
    );
    return result as unknown as Record<string, unknown>[];
  };

  it('returns every field as its correct Postgres type', async () => {
    const { formId, versionId } = await publishForm(org, 'typed_form', [
      { key: 'student_name', dataType: 'short_text' },
      { key: 'age', dataType: 'integer' },
      { key: 'score', dataType: 'number' },
      { key: 'visit_date', dataType: 'date' },
      { key: 'present', dataType: 'boolean' },
      { key: 'house', dataType: 'geopoint' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: versionId,
      locationId: org.villageAId,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: {
        student_name: 'Sunita Devi',
        age: 12,
        score: 78.5,
        visit_date: '2026-08-05',
        present: true,
        house: { lat: 19.6967, lon: 73.5561, accuracy: 8.2 },
      },
    });

    const [row] = await readView('typed_form');

    expect(row?.student_name).toBe('Sunita Devi');
    // Real typed values, not strings — this is the whole point of the views.
    expect(row?.age).toBe(12);
    expect(Number(row?.score)).toBe(78.5);
    expect(row?.present).toBe(true);
    // A bare `date` comes back as an ISO string, not a Date — no timezone to
    // shift it, which is what a date-of-birth or visit-date needs.
    expect(row?.visit_date).toBe('2026-08-05');
    expect(row?.house_lat).toBeCloseTo(19.6967, 4);
    expect(row?.house_lon).toBeCloseTo(73.5561, 4);
    expect(row?.house_accuracy_m).toBeCloseTo(8.2, 2);
  });

  it('survives a schema change: old rows keep their values, new column back-fills NULL', async () => {
    // The scenario the design exists for — an admin adds a question mid-programme
    // and no historical data moves, breaks or disappears.
    const { formId, versionId: v1 } = await publishForm(org, 'evolving_form', [
      { key: 'student_name', dataType: 'short_text' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: v1,
      locationId: org.villageAId,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      submittedAt: new Date('2026-01-01T00:00:00Z'),
      data: { student_name: 'Before the change' },
    });

    const { versionId: v2 } = await publishForm(
      org,
      'evolving_form',
      [
        { key: 'student_name', dataType: 'short_text' },
        { key: 'attendance_pct', dataType: 'number' },
      ],
      { formId, versionNumber: 2 },
    );
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: v2,
      locationId: org.villageAId,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      submittedAt: new Date('2026-02-01T00:00:00Z'),
      data: { student_name: 'After the change', attendance_pct: 91.5 },
    });

    const rows = await readView('evolving_form');

    expect(rows).toHaveLength(2);
    expect(rows[0]?.student_name).toBe('Before the change');
    expect(rows[0]?.attendance_pct).toBeNull();
    expect(rows[0]?.form_version).toBe(1);
    expect(rows[1]?.student_name).toBe('After the change');
    expect(Number(rows[1]?.attendance_pct)).toBe(91.5);
    expect(rows[1]?.form_version).toBe(2);
  });

  it('expands a repeating group into one child row per entry', async () => {
    const { formId, versionId } = await publishForm(org, 'household_form', [
      { key: 'head_name', dataType: 'short_text' },
      { key: 'members', dataType: 'repeat_group' },
      { key: 'member_name', dataType: 'short_text', parentGroupKey: 'members' },
      { key: 'member_age', dataType: 'integer', parentGroupKey: 'members' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: versionId,
      locationId: org.villageAId,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: {
        head_name: 'Ramesh Kadam',
        members: [
          { member_name: 'Ramesh', member_age: 40 },
          { member_name: 'Sita', member_age: 38 },
          { member_name: 'Anjali', member_age: 12 },
        ],
      },
    });

    const parents = await readView('household_form');
    expect(parents).toHaveLength(1);
    expect(parents[0]?.head_name).toBe('Ramesh Kadam');

    const children = await ownerDb().execute(
      sql.raw(
        `SELECT * FROM ${pgIdentifier(org.analyticsSchema)}."household_form__members" ORDER BY entry_index`,
      ),
    );
    const rows = children as unknown as Record<string, unknown>[];

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.member_name)).toEqual(['Ramesh', 'Sita', 'Anjali']);
    expect(rows.map((r) => r.member_age)).toEqual([40, 38, 12]);
    // Every child row joins back to its parent submission.
    expect(new Set(rows.map((r) => r.submission_id)).size).toBe(1);
    expect(rows[0]?.submission_id).toBe(parents[0]?.submission_id);
  });

  it('excludes drafts and soft-deleted submissions', async () => {
    const { formId, versionId } = await publishForm(org, 'status_form', [
      { key: 'note', dataType: 'short_text' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb()
      .insert(submissions)
      .values([
        {
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          status: 'draft',
          data: { note: 'half-finished' },
        },
        {
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          status: 'submitted',
          deletedAt: new Date(),
          data: { note: 'withdrawn' },
        },
        {
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          status: 'submitted',
          data: { note: 'counted' },
        },
      ]);

    const rows = await readView('status_form');
    expect(rows.map((r) => r.note)).toEqual(['counted']);
  });

  it('yields NULL for an unparseable value instead of breaking the view', async () => {
    // A widened field type or a bulk import can leave a value the column type
    // cannot hold. That must cost one cell, not the entire report.
    const { formId, versionId } = await publishForm(org, 'messy_form', [
      { key: 'name', dataType: 'short_text' },
      { key: 'count', dataType: 'integer' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb()
      .insert(submissions)
      .values([
        {
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          data: { name: 'good row', count: 5 },
        },
        {
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          data: { name: 'bad row', count: 'not a number' },
        },
      ]);

    const rows = await readView('messy_form');

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'good row')?.count).toBe(5);
    expect(rows.find((r) => r.name === 'bad row')?.count).toBeNull();
  });

  it('yields NULL for a number too large to hold, rather than raising', async () => {
    /*
     * The sharper version of the case above, and the one that actually shipped.
     * `1e1000000` is a *syntactically valid* number — the regex that guards the
     * cast passed it happily — and no numeric can hold it, so the cast raised
     * and took the entire view down with it. Every column, every row, for one
     * cell somebody typed into a free-text question that was later widened.
     */
    const { formId, versionId } = await publishForm(org, 'huge_form', [
      { key: 'name', dataType: 'short_text' },
      { key: 'amount', dataType: 'number' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb()
      .insert(submissions)
      .values([
        {
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          data: { name: 'ordinary', amount: 1250.5 },
        },
        {
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          data: { name: 'absurd', amount: '1e1000000' },
        },
      ]);

    const rows = await readView('huge_form');

    // The whole report still reads, which is the point.
    expect(rows).toHaveLength(2);
    expect(Number(rows.find((r) => r.name === 'ordinary')?.amount)).toBe(1250.5);
    expect(rows.find((r) => r.name === 'absurd')?.amount).toBeNull();
  });

  it('holds every cast to the promise that it does not raise', async () => {
    // Asserted on the functions directly as well, because a view only exercises
    // whichever casts its own questions happen to use.
    const [row] = (await ownerDb().execute(sql`
      SELECT
        analytics.try_double('1e999')          AS over_double,
        analytics.try_double('-1e999')         AS under_double,
        analytics.try_numeric('1e1000000')     AS over_numeric,
        analytics.try_double('1e-999')         AS tiny,
        analytics.try_double('42.5')           AS ordinary,
        analytics.try_double('1e300')          AS large_but_real,
        analytics.try_numeric('123.456')       AS ordinary_numeric,
        analytics.try_double('  7  ')          AS padded,
        analytics.try_double('abc')            AS words,
        analytics.try_bigint('99999999999999999999') AS over_bigint
    `)) as unknown as Record<string, unknown>[];

    expect(row!.over_double).toBeNull();
    expect(row!.under_double).toBeNull();
    expect(row!.over_numeric).toBeNull();
    expect(row!.words).toBeNull();
    expect(row!.over_bigint).toBeNull();

    // Underflow is a real zero, not an error: only overflow has nowhere to go.
    expect(Number(row!.tiny)).toBe(0);
    // And nothing representable was lost on the way to making that true.
    expect(Number(row!.ordinary)).toBe(42.5);
    expect(Number(row!.large_but_real)).toBe(1e300);
    expect(Number(row!.ordinary_numeric)).toBe(123.456);
    expect(Number(row!.padded)).toBe(7);
  });

  it('keeps a repeating group\'s child view after the group is removed', async () => {
    // Removing a question from a later version must not make the answers
    // already collected under it unreadable. The generator merges fields across
    // every published version, so the child view survives with its historical
    // rows and simply stops gaining new ones.
    const { formId, versionId: v1 } = await publishForm(org, 'shrinking_form', [
      { key: 'items', dataType: 'repeat_group' },
      { key: 'item_name', dataType: 'short_text', parentGroupKey: 'items' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: v1,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: { items: [{ item_name: 'collected under v1' }] },
    });

    await publishForm(org, 'shrinking_form', [{ key: 'summary', dataType: 'short_text' }], {
      formId,
      versionNumber: 2,
    });
    await regenerateFormViews(ownerDb(), formId);

    const rows = (await ownerDb().execute(
      sql.raw(
        `SELECT item_name FROM ${pgIdentifier(org.analyticsSchema)}."shrinking_form__items"`,
      ),
    )) as unknown as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.item_name).toBe('collected under v1');
  });

  it('drops views for a form with nothing published', async () => {
    // The genuine cleanup case: a form whose versions are all withdrawn should
    // not leave a queryable view behind reporting rows that no longer qualify.
    const { formId } = await publishForm(org, 'withdrawn_form', [
      { key: 'note', dataType: 'short_text' },
    ]);
    await regenerateFormViews(ownerDb(), formId);

    const exists = async () => {
      const result = await ownerDb().execute(sql`
        SELECT 1 FROM information_schema.views
        WHERE table_schema = ${org.analyticsSchema} AND table_name = 'withdrawn_form'
      `);
      return (result as unknown as unknown[]).length > 0;
    };
    expect(await exists()).toBe(true);

    await ownerDb()
      .update(formVersions)
      .set({ status: 'archived' })
      .where(eq(formVersions.formId, formId));
    const result = await regenerateFormViews(ownerDb(), formId);

    expect(result.dropped).toContain('withdrawn_form');
    expect(await exists()).toBe(false);
  });
});
