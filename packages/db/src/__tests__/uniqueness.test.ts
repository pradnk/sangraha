/**
 * "No two records may have the same answer", verified against the database.
 *
 * The rule exists to stop the same beneficiary being enrolled twice under one
 * phone number or ration card. What makes it worth testing properly is that a
 * naive implementation looks correct and fails exactly when it matters: two
 * workers submitting at the same moment both look, both find nothing, and both
 * save.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database } from '../client';
import {
  countExistingDuplicates,
  findDuplicateAnswers,
  normaliseForUniqueness,
} from '../queries/submissions';
import { submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe('comparing answers', () => {
  it('ignores capitals and surrounding spaces', () => {
    // An email or an ID number typed with a trailing space is the same value,
    // and treating it as different would make the rule useless in practice.
    expect(normaliseForUniqueness('  ABC@Example.COM ')).toBe('abc@example.com');
    expect(normaliseForUniqueness('9876500011')).toBe('9876500011');
  });

  it('treats a blank answer as no value at all', () => {
    // Two people who both left it empty are not duplicates of one another.
    expect(normaliseForUniqueness('')).toBeNull();
    expect(normaliseForUniqueness('   ')).toBeNull();
    expect(normaliseForUniqueness(null)).toBeNull();
    expect(normaliseForUniqueness(undefined)).toBeNull();
  });

  it('does not try to compare a list or an object', () => {
    // A multi-choice answer compares as JSON text, so the same picks in a
    // different order would slip past. Excluded rather than half-enforced.
    expect(normaliseForUniqueness(['a', 'b'])).toBeNull();
    expect(normaliseForUniqueness({ a: 1 })).toBeNull();
  });

  it('does not fold the spaces inside a value', () => {
    // Tempting for "1234 5678 9012", and wrong: it would also merge two
    // genuinely different free-text answers, invisibly.
    expect(normaliseForUniqueness('1234 5678 9012')).toBe('1234 5678 9012');
  });
});

describe.skipIf(!hasDatabase)('unique answers', () => {
  let org: TestOrg;
  let appClient: postgres.Sql;
  let appDb: Database;
  let formId: string;
  let versionId: string;
  let otherFormId: string;
  let otherVersionId: string;

  const save = async (
    data: Record<string, unknown>,
    opts: {
      status?: 'submitted' | 'draft';
      formId?: string;
      versionId?: string;
      submittedBy?: string;
      locationId?: string;
    } = {},
  ): Promise<string> => {
    const [row] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId: opts.formId ?? formId,
        formVersionId: opts.versionId ?? versionId,
        locationId: opts.locationId ?? org.villageAId,
        submittedBy: opts.submittedBy ?? org.workerAId,
        clientUuid: randomUUID(),
        status: opts.status ?? 'submitted',
        data,
      })
      .returning({ id: submissions.id });
    return row!.id;
  };

  /*
   * Run through the real application connection, under a field worker's own
   * RLS context — not on `ownerDb()`, which bypasses the policies entirely.
   *
   * That distinction is not incidental. Every test in this file passed while
   * the rule was doing nothing across workers, because the owner connection saw
   * every row and the request path could not. A test for a policy-shaped bug
   * has to run where the policies do.
   */
  const asWorker = async <T>(
    userId: string,
    work: (tx: Database) => Promise<T>,
  ): Promise<T> =>
    appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      await tx.execute(sql`select set_config('app.role', 'field_worker', true)`);
      return work(tx as unknown as Database);
    });

  const check = (data: Record<string, unknown>, excludeSubmissionId?: string) =>
    asWorker(org.workerAId, (tx) =>
      findDuplicateAnswers(tx, {
        formId,
        uniqueKeys: ['phone'],
        data,
        excludeSubmissionId,
      }),
    );

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('unique');
    ({ formId, versionId } = await publishForm(org, 'intake', [
      { key: 'phone', dataType: 'short_text' },
      { key: 'note', dataType: 'short_text' },
    ]));
    ({ formId: otherFormId, versionId: otherVersionId } = await publishForm(org, 'other', [
      { key: 'phone', dataType: 'short_text' },
    ]));
  });

  afterAll(async () => {
    await appClient?.end({ timeout: 5 });
    await dropTestOrg(org);
    await closeHarness();
  });

  it('lets the first record through', async () => {
    expect(await check({ phone: '9000000001' })).toEqual([]);
  });

  it('refuses a second record with the same answer', async () => {
    await save({ phone: '9000000002' });

    const clashes = await check({ phone: '9000000002' });
    expect(clashes).toEqual([{ fieldKey: 'phone', value: '9000000002' }]);
  });

  it('refuses it however it was typed', async () => {
    await save({ phone: 'ABC-123' });

    // Same value, different capitals and a stray space.
    expect(await check({ phone: ' abc-123 ' })).toHaveLength(1);
  });

  it('allows a blank answer as often as it likes', async () => {
    await save({ phone: '', note: 'first' });
    await save({ phone: '   ', note: 'second' });

    expect(await check({ phone: '' })).toEqual([]);
  });

  it('does not count drafts', async () => {
    // A half-typed number must not block somebody else's finished one.
    await save({ phone: '9000000003' }, { status: 'draft' });

    expect(await check({ phone: '9000000003' })).toEqual([]);
  });

  it('does not count a deleted record', async () => {
    const id = await save({ phone: '9000000004' });
    await ownerDb()
      .update(submissions)
      .set({ deletedAt: new Date() })
      .where(eq(submissions.id, id));

    expect(await check({ phone: '9000000004' })).toEqual([]);
  });

  it('lets a record keep its own answer when edited', async () => {
    const id = await save({ phone: '9000000005' });

    // Without excluding itself, correcting the note would report the phone
    // number as a duplicate of the very record being corrected.
    expect(await check({ phone: '9000000005' }, id)).toEqual([]);
  });

  it('sees a record captured by a different worker in a different village', async () => {
    /*
     * The defect, and the whole reason the rule exists. `submissions_isolation`
     * restricts a `field_worker` to `submitted_by = app.current_user_id()`, so
     * the clash SELECT — running on the request transaction — could only ever
     * find the caller's own submissions. Worker A enrolling somebody Worker B
     * had already enrolled sailed straight through.
     *
     * Every other test in this file passed throughout, because they all ran on
     * `ownerDb()`, which bypasses the policies.
     */
    await save({ phone: '9000000101' }, {
      submittedBy: org.workerBId,
      locationId: org.villageBId,
    });

    expect(await check({ phone: '9000000101' })).toEqual([
      { fieldKey: 'phone', value: '9000000101' },
    ]);
  });

  it('does not let a worker read anything of the other worker\'s beyond that', async () => {
    // The check answers one question — "is this value already in use here" —
    // and the policy still stands for everything else. Worker A cannot list
    // Worker B's record, only collide with it.
    await save({ phone: '9000000102', note: 'B only' }, {
      submittedBy: org.workerBId,
      locationId: org.villageBId,
    });

    const visible = await asWorker(org.workerAId, async (tx) => {
      const rows = (await tx.execute(
        sql`select data->>'note' as note from submissions where form_id = ${formId}::uuid`,
      )) as unknown as { note: string | null }[];
      return rows.map((r) => r.note);
    });

    expect(visible).not.toContain('B only');
  });

  it('stays inside the organisation', async () => {
    /*
     * The function is SECURITY DEFINER, so it steps around the policy that
     * would otherwise scope it — which makes "and no further than the org" a
     * property of the function body rather than of the policies. Worth an
     * assertion of its own.
     */
    const other = await createTestOrg('unique-other');
    try {
      const theirForm = await publishForm(other, 'intake', [
        { key: 'phone', dataType: 'short_text' },
      ]);
      await ownerDb().insert(submissions).values({
        orgId: other.id,
        formId: theirForm.formId,
        formVersionId: theirForm.versionId,
        locationId: other.villageAId,
        submittedBy: other.workerAId,
        clientUuid: randomUUID(),
        status: 'submitted',
        data: { phone: '9000000103' },
      });

      // Same number, our form. Another tenant's data is not our clash.
      expect(await check({ phone: '9000000103' })).toEqual([]);

      // And asking about *their* form from our context finds nothing either.
      const across = await asWorker(org.workerAId, (tx) =>
        findDuplicateAnswers(tx, {
          formId: theirForm.formId,
          uniqueKeys: ['phone'],
          data: { phone: '9000000103' },
        }),
      );
      expect(across).toEqual([]);
    } finally {
      await dropTestOrg(other);
    }
  });

  it('is scoped to one form, not the whole organisation', async () => {
    await save({ phone: '9000000006' }, { formId: otherFormId, versionId: otherVersionId });

    // The same number on a different form is a different question. A survey
    // must not block a registration.
    expect(await check({ phone: '9000000006' })).toEqual([]);
  });

  it('checks nothing when no question is marked unique', async () => {
    await save({ phone: '9000000007' });

    const clashes = await asWorker(org.workerAId, (tx) =>
      findDuplicateAnswers(tx, {
        formId,
        uniqueKeys: [],
        data: { phone: '9000000007' },
      }),
    );
    expect(clashes).toEqual([]);
  });

  describe('two workers submitting at the same moment', () => {
    /*
     * The case a check-then-insert gets wrong. Both transactions look, both
     * find nothing, and both save — so the rule holds right up until the day
     * two people actually do it at once, which is the day it was needed.
     *
     * Run through two real connections so the transactions genuinely overlap,
     * and as two *different* workers on the application connection — which is
     * both the scenario the rule exists for and the one the policies used to
     * hide, since each worker could only see their own rows.
     */
    let a: postgres.Sql;
    let b: postgres.Sql;

    beforeAll(() => {
      a = createPostgresClient(process.env.DATABASE_APP_URL!, 2);
      b = createPostgresClient(process.env.DATABASE_APP_URL!, 2);
    });

    afterAll(async () => {
      await a?.end();
      await b?.end();
    });

    it('lets exactly one of them through', async () => {
      const phone = '9111000001';

      /** Checks, waits so the two genuinely overlap, then saves if clear. */
      const attempt = async (
        client: postgres.Sql,
        note: string,
        userId: string,
        locationId: string,
      ): Promise<boolean> => {
        const db = drizzle(client) as unknown as Database;
        return db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
          await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
          await tx.execute(sql`select set_config('app.role', 'field_worker', true)`);

          const clashes = await findDuplicateAnswers(tx as unknown as Database, {
            formId,
            uniqueKeys: ['phone'],
            data: { phone },
          });
          if (clashes.length > 0) return false;

          await tx.insert(submissions).values({
            orgId: org.id,
            formId,
            formVersionId: versionId,
            locationId,
            submittedBy: userId,
            clientUuid: randomUUID(),
            status: 'submitted',
            data: { phone, note },
          });
          return true;
        });
      };

      const [first, second] = await Promise.all([
        attempt(a, 'first', org.workerAId, org.villageAId),
        attempt(b, 'second', org.workerBId, org.villageBId),
      ]);

      // One saved, one refused — never both.
      expect([first, second].filter(Boolean)).toHaveLength(1);

      const saved = await ownerDb()
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.formId, formId));
      const withPhone = saved.length;
      expect(withPhone).toBeGreaterThan(0);

      const rows = (await ownerDb().execute(
        // Counted in SQL so the assertion does not depend on the same
        // normalisation the code under test uses.
        `SELECT count(*)::int AS n FROM submissions
         WHERE form_id = '${formId}' AND data->>'phone' = '${phone}'`,
      )) as unknown as { n: number }[];

      expect(Number(rows[0]!.n)).toBe(1);
    });
  });

  describe('duplicates already in the data', () => {
    it('reports what is already there, so publishing can say so', async () => {
      const { formId: legacyForm, versionId: legacyVersion } = await publishForm(
        org,
        'legacy',
        [{ key: 'card', dataType: 'short_text' }],
      );

      for (const card of ['AAA', 'aaa', ' AAA ', 'BBB', 'BBB', 'CCC']) {
        await save({ card }, { formId: legacyForm, versionId: legacyVersion });
      }

      const repeats = await countExistingDuplicates(ownerDb(), legacyForm, 'card');

      // AAA three times (however typed) and BBB twice. CCC appears once, so it
      // is not a duplicate.
      expect(repeats).toEqual([
        { value: 'aaa', count: 3 },
        { value: 'bbb', count: 2 },
      ]);
    });

    it('says nothing when the data is clean', async () => {
      expect(await countExistingDuplicates(ownerDb(), otherFormId, 'phone')).toEqual([]);
    });
  });
});
