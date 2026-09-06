/**
 * The registry, verified against the database.
 *
 * What distinguishes this product from a form collector is that a person
 * registered in April and visited in September is one record, not two. These
 * assertions cover that chain: registration creates a subject, encounters hang
 * off it, and a duplicate can be linked without destroying anything.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database, type RequestContext } from '../client';
import { subjects, submissions } from '../schema/index';
import {
  backfillSubjectsForForm,
  countUnregisteredSubmissions,
  createSubjectFromRegistration,
  findDuplicateCandidates,
  getSubject,
  getSubjectTimeline,
  markAsDuplicate,
  searchSubjects,
  unmarkDuplicate,
} from '../queries/subjects';
import { composeDisplayName } from '../queries/subject-types';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('registry', () => {
  let appClient: postgres.Sql;
  let appDb: Database;
  let org: TestOrg;
  let subjectTypeId: string;
  let registrationFormId: string;
  let registrationVersionId: string;
  let attendanceFormId: string;
  let attendanceVersionId: string;

  /** Runs a query under an explicit RLS context, exactly as a request would. */
  async function asUser<T>(
    context: RequestContext,
    work: (tx: Database) => Promise<T>,
  ): Promise<T> {
    return appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${context.orgId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
      await tx.execute(sql`select set_config('app.role', ${context.role}, true)`);
      return work(tx as unknown as Database);
    });
  }

  const workerA = (): RequestContext => ({
    orgId: org.id,
    userId: org.workerAId,
    role: 'field_worker',
  });
  const workerB = (): RequestContext => ({
    orgId: org.id,
    userId: org.workerBId,
    role: 'field_worker',
  });
  const admin = (): RequestContext => ({
    orgId: org.id,
    userId: org.adminId,
    role: 'org_admin',
  });

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('registry');

    const registration = await publishForm(
      org,
      'child_registration',
      [
        { key: 'first_name', dataType: 'text' },
        { key: 'last_name', dataType: 'text' },
        { key: 'guardian_phone', dataType: 'text' },
      ],
      {
        formType: 'registration',
        displayNameFields: ['first_name', 'last_name'],
        matchFields: ['guardian_phone'],
      },
    );
    subjectTypeId = registration.subjectTypeId;
    registrationFormId = registration.formId;
    registrationVersionId = registration.versionId;

    const attendance = await publishForm(org, 'attendance', [{ key: 'present', dataType: 'text' }], {
      formType: 'encounter',
      subjectTypeId,
    });
    attendanceFormId = attendance.formId;
    attendanceVersionId = attendance.versionId;
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await appClient?.end();
    await closeHarness();
  });

  /** Registers a person the way the submissions endpoint does. */
  async function register(
    context: RequestContext,
    locationId: string,
    answers: Record<string, unknown>,
    submittedAt?: Date,
  ): Promise<string> {
    return asUser(context, async (tx) => {
      const subject = await createSubjectFromRegistration(tx, {
        orgId: org.id,
        subjectTypeId,
        answers,
        locationId,
        createdBy: context.userId,
      });
      await tx.insert(submissions).values({
        orgId: org.id,
        formId: registrationFormId,
        formVersionId: registrationVersionId,
        subjectId: subject.id,
        locationId,
        data: answers,
        status: 'submitted',
        submittedBy: context.userId,
        clientUuid: randomUUID(),
        ...(submittedAt ? { submittedAt } : {}),
      });
      return subject.id;
    });
  }

  describe('display names', () => {
    it('joins the chosen answers in the order they were chosen', () => {
      expect(
        composeDisplayName(['first_name', 'last_name'], { first_name: 'Sunita', last_name: 'Devi' }, 'Child'),
      ).toBe('Sunita Devi');
    });

    it('never leaves a subject nameless', () => {
      // An unnamed row in a "find a person" list is useless to the person
      // searching, so a missing answer falls back to the type's name rather
      // than to an empty string.
      expect(composeDisplayName(['first_name'], {}, 'Child')).toBe('Child');
      expect(composeDisplayName([], { first_name: 'Sunita' }, 'Child')).toBe('Child');
      expect(composeDisplayName(['first_name', 'last_name'], { first_name: 'Sunita' }, 'Child')).toBe(
        'Sunita',
      );
    });
  });

  describe('registration', () => {
    it('creates a subject carrying the composed name and the answers', async () => {
      const id = await register(workerA(), org.villageAId, {
        first_name: 'Sunita',
        last_name: 'Devi',
        guardian_phone: '9876500011',
      });

      const found = await asUser(workerA(), (tx) => getSubject(tx, id));
      expect(found?.displayName).toBe('Sunita Devi');
      expect(found?.attributes).toMatchObject({ guardian_phone: '9876500011' });
      expect(found?.locationId).toBe(org.villageAId);
      expect(found?.duplicateOfId).toBeNull();
    });

    it('links the submission to the subject it registered', async () => {
      const id = await register(workerA(), org.villageAId, {
        first_name: 'Kavita',
        last_name: 'Sharma',
      });

      const [row] = await ownerDb()
        .select({ subjectId: submissions.subjectId })
        .from(submissions)
        .where(eq(submissions.subjectId, id))
        .limit(1);

      expect(row?.subjectId).toBe(id);
    });
  });

  describe('search', () => {
    it('finds a name that was spelled differently', async () => {
      await register(workerA(), org.villageAId, { first_name: 'Anjali', last_name: 'Patil' });

      // The whole reason for the trigram index: a worker who has to spell a
      // name identically twice will give up and register a second copy.
      const results = await asUser(workerA(), (tx) =>
        searchSubjects(tx, { query: 'Anjalee Patil' }),
      );
      expect(results.map((r) => r.displayName)).toContain('Anjali Patil');
    });

    it('does not reach into another worker’s villages', async () => {
      await register(workerB(), org.villageBId, { first_name: 'Meena', last_name: 'Rao' });

      const mine = await asUser(workerA(), (tx) => searchSubjects(tx, { query: 'Meena Rao' }));
      expect(mine).toHaveLength(0);

      // The record exists — it is the policy hiding it, not a missing row.
      const theirs = await asUser(workerB(), (tx) => searchSubjects(tx, { query: 'Meena Rao' }));
      expect(theirs.map((r) => r.displayName)).toContain('Meena Rao');
    });
  });

  describe('timeline', () => {
    it('returns every encounter against a subject, newest first', async () => {
      // Registered before the visits, so newest-first has something to order.
      const id = await register(
        workerA(),
        org.villageAId,
        { first_name: 'Priya', last_name: 'Kumari' },
        new Date('2025-12-01T09:00:00Z'),
      );

      const days = ['2026-01-10T09:00:00Z', '2026-02-10T09:00:00Z', '2026-03-10T09:00:00Z'];
      for (const day of days) {
        await ownerDb()
          .insert(submissions)
          .values({
            orgId: org.id,
            formId: attendanceFormId,
            formVersionId: attendanceVersionId,
            subjectId: id,
            locationId: org.villageAId,
            data: { present: day.slice(0, 10) },
            status: 'submitted',
            submittedBy: org.workerAId,
            submittedAt: new Date(day),
            clientUuid: randomUUID(),
          });
      }

      const timeline = await asUser(workerA(), (tx) => getSubjectTimeline(tx, id));

      // The registration itself plus three visits — the longitudinal view that
      // is the point of the registry.
      expect(timeline).toHaveLength(4);
      expect(timeline.map((e) => e.formType)).toEqual([
        'encounter',
        'encounter',
        'encounter',
        'registration',
      ]);
      expect(timeline.slice(0, 3).map((e) => e.data.present)).toEqual([
        '2026-03-10',
        '2026-02-10',
        '2026-01-10',
      ]);
    });
  });

  describe('catching up records that registered nobody', () => {
    /*
     * The defect: a registration form with no subject type saves its
     * submissions perfectly well and registers no one. The form said
     * "Registers a person", a worker filled it in, and nobody appeared under
     * Find a person — with no error anywhere. Forms built before the registry
     * existed are all in that state, and the data is real, so the repair has
     * to catch the records up rather than ask anyone to type them again.
     */
    let orphanFormId: string;
    let orphanVersionId: string;

    beforeAll(async () => {
      const form = await publishForm(
        org,
        'old_intake',
        [{ key: 'first_name', dataType: 'text' }, { key: 'last_name', dataType: 'text' }],
        { formType: 'registration', subjectTypeId },
      );
      orphanFormId = form.formId;
      orphanVersionId = form.versionId;

      const rows = [
        { first_name: 'Parvati', last_name: 'Naik', status: 'submitted' },
        { first_name: 'Shanta', last_name: 'Hegde', status: 'approved' },
        // A draft is half-filled by definition; registering somebody from one
        // would put a half-named record in everybody's search results.
        { first_name: 'Half', last_name: 'Typed', status: 'draft' },
      ];

      for (const row of rows) {
        await ownerDb()
          .insert(submissions)
          .values({
            orgId: org.id,
            formId: orphanFormId,
            formVersionId: orphanVersionId,
            locationId: org.villageAId,
            data: { first_name: row.first_name, last_name: row.last_name },
            status: row.status as 'draft' | 'submitted' | 'approved',
            submittedBy: org.workerAId,
            clientUuid: randomUUID(),
          });
      }
    });

    it('counts the records that registered nobody, ignoring drafts', async () => {
      expect(await countUnregisteredSubmissions(ownerDb(), org.id, orphanFormId)).toBe(2);
    });

    it('registers them with the name the answers compose', async () => {
      const { registered } = await backfillSubjectsForForm(ownerDb(), {
        orgId: org.id,
        formId: orphanFormId,
        subjectTypeId,
        createdBy: org.adminId,
      });

      expect(registered).toBe(2);

      const found = await asUser(workerA(), (tx) => searchSubjects(tx, { query: 'Parvati Naik' }));
      expect(found.map((r) => r.displayName)).toContain('Parvati Naik');
    });

    it('leaves the draft alone', async () => {
      const found = await asUser(workerA(), (tx) => searchSubjects(tx, { query: 'Half Typed' }));
      expect(found).toHaveLength(0);
    });

    it('credits the worker who captured the record, not the admin who repaired it', async () => {
      const [row] = await ownerDb()
        .select({ createdBy: subjects.createdBy })
        .from(subjects)
        .where(eq(subjects.displayName, 'Parvati Naik'))
        .limit(1);

      // They are the person who actually met them.
      expect(row?.createdBy).toBe(org.workerAId);
    });

    it('links each submission to the person it registered', async () => {
      const remaining = await countUnregisteredSubmissions(ownerDb(), org.id, orphanFormId);
      expect(remaining).toBe(0);
    });

    it('is safe to run twice', async () => {
      // An admin who taps the button again, or a double submit, must not
      // produce two records for one person.
      const { registered } = await backfillSubjectsForForm(ownerDb(), {
        orgId: org.id,
        formId: orphanFormId,
        subjectTypeId,
        createdBy: org.adminId,
      });

      expect(registered).toBe(0);

      const found = await asUser(workerA(), (tx) => searchSubjects(tx, { query: 'Shanta Hegde' }));
      expect(found).toHaveLength(1);
    });

    it('refuses a subject type from another organisation', async () => {
      const other = await createTestOrg('registry-backfill-other');
      try {
        const theirs = await publishForm(other, 'theirs', [{ key: 'x', dataType: 'text' }], {
          formType: 'registration',
        });

        const { registered } = await backfillSubjectsForForm(ownerDb(), {
          orgId: org.id,
          formId: orphanFormId,
          subjectTypeId: theirs.subjectTypeId,
          createdBy: org.adminId,
        });

        expect(registered).toBe(0);
      } finally {
        await dropTestOrg(other);
      }
    });
  });

  describe('duplicate detection', () => {
    /**
     * The check runs on the owner connection on purpose — see
     * `findDuplicateCandidates`. These tests use the owner connection too,
     * which is what makes the redaction assertions meaningful: the data is
     * right there and the function still must not return it.
     */
    const check = (viewerId: string, role: string, answers: Record<string, unknown>) =>
      findDuplicateCandidates(ownerDb(), {
        orgId: org.id,
        subjectTypeId,
        displayName: composeDisplayName(['first_name', 'last_name'], answers, ''),
        answers,
        matchFields: ['guardian_phone'],
        viewer: { userId: viewerId, role },
      });

    it('warns about a name spelled slightly differently', async () => {
      await register(workerA(), org.villageAId, { first_name: 'Lakshmi', last_name: 'Naidu' });

      const result = await check(org.workerAId, 'field_worker', {
        first_name: 'Lakshmee',
        last_name: 'Naidu',
      });

      expect(result.visible.map((m) => m.displayName)).toContain('Lakshmi Naidu');
      expect(result.visible[0]!.reasons).toContain('name');
      expect(result.visible[0]!.score).toBeGreaterThanOrEqual(0.4);
    });

    it('warns on an exact match field even when the name is nothing alike', async () => {
      await register(workerA(), org.villageAId, {
        first_name: 'Radha',
        last_name: 'Krishnan',
        guardian_phone: '9000011111',
      });

      // Married name, nickname, a transliteration nobody would guess — the
      // phone number is what actually identifies the household.
      const result = await check(org.workerAId, 'field_worker', {
        first_name: 'Completely',
        last_name: 'Different',
        guardian_phone: '9000011111',
      });

      expect(result.visible).toHaveLength(1);
      expect(result.visible[0]!.reasons).toEqual(['guardian_phone']);
    });

    it('returns a date the phone can actually parse', async () => {
      await register(workerA(), org.villageAId, { first_name: 'Nirmala', last_name: 'Joshi' });

      const result = await check(org.workerAId, 'field_worker', {
        first_name: 'Nirmala',
        last_name: 'Joshi',
      });

      // Postgres's own text form ends in a bare `+00`, which Safari on iOS
      // parses as Invalid Date — so the registration date, the very thing a
      // worker uses to tell two people apart, would silently vanish on
      // exactly the devices this screen is built for.
      const serialised = JSON.parse(JSON.stringify(result)) as {
        visible: { registeredAt: string }[];
      };
      const registeredAt = serialised.visible[0]!.registeredAt;
      expect(registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      expect(Number.isNaN(new Date(registeredAt).getTime())).toBe(false);
    });

    it('stays quiet when nobody is alike', async () => {
      const result = await check(org.workerAId, 'field_worker', {
        first_name: 'Zubeida',
        last_name: 'Qureshi',
      });
      expect(result).toEqual({ visible: [], hiddenCount: 0 });
    });

    it('does not let matches elsewhere crowd out the one next door', async () => {
      /*
       * The LIMIT was applied in SQL before the visible/hidden split happened
       * in TypeScript. So in an organisation with the same name in many
       * villages, ten near-identical scores from elsewhere filled the ten slots
       * ordered by `registered_at DESC`, the worker's own village's record
       * ranked eleventh, and the answer came back `visible: []` with
       * `hiddenCount: 10`. The worker was told somebody similar existed
       * somewhere else, tapped "Register anyway", and created exactly the local
       * duplicate the check exists to prevent.
       */
      const name = { first_name: 'Padma', last_name: 'Rao' };

      // The one in their own village, registered first so it sorts last.
      await register(workerA(), org.villageAId, name);

      // Twelve more elsewhere, all newer and all scoring the same.
      for (let i = 0; i < 12; i += 1) {
        await register(workerB(), org.villageBId, name);
      }

      const result = await check(org.workerAId, 'field_worker', name);

      // The one they can act on is in front of them.
      expect(result.visible).toHaveLength(1);
      // And the count is the real number, not however many fitted in the limit.
      expect(result.hiddenCount).toBe(12);
    });

    it('still reports the hidden count when nothing visible matched', async () => {
      // The count comes from its own aggregate now rather than from the rows,
      // so it has to survive there being no rows at all.
      const name = { first_name: 'Yamuna', last_name: 'Bai' };
      await register(workerB(), org.villageBId, name);
      await register(workerB(), org.villageBId, name);

      const result = await check(org.workerAId, 'field_worker', name);

      expect(result.visible).toEqual([]);
      expect(result.hiddenCount).toBe(2);
    });

    it('reports a match in another village as a bare count', async () => {
      await register(workerB(), org.villageBId, {
        first_name: 'Shabana',
        last_name: 'Begum',
        guardian_phone: '9111122222',
      });

      const result = await check(org.workerAId, 'field_worker', {
        first_name: 'Shabana',
        last_name: 'Begum',
      });

      // The privacy promise: enough to send the worker to their supervisor,
      // not enough to look anybody up.
      expect(result.hiddenCount).toBe(1);
      expect(result.visible).toEqual([]);

      // Asserting the *absence* of the fields, not just that `visible` is
      // empty — a future refactor that leaked a redacted entry into the
      // payload would still satisfy the count.
      const payload = JSON.stringify(result);
      expect(payload).not.toContain('Shabana');
      expect(payload).not.toContain('Village B');
      expect(payload).not.toContain(org.villageBId);

      // And the registration answers, which the cards now show so that two
      // people with one name can be told apart. Those are exactly the details
      // an out-of-scope match must not hand over.
      expect(payload).not.toContain('9111122222');
    });

    it('shows the supervisor what the worker was only counted', async () => {
      await register(workerB(), org.villageBId, { first_name: 'Farida', last_name: 'Sheikh' });

      const forWorker = await check(org.workerAId, 'field_worker', {
        first_name: 'Farida',
        last_name: 'Sheikh',
      });
      expect(forWorker.hiddenCount).toBe(1);

      // The supervisor holds the district, which contains both villages — so
      // the redaction is about location scope, not about the record.
      const forSupervisor = await check(org.supervisorId, 'supervisor', {
        first_name: 'Farida',
        last_name: 'Sheikh',
      });
      expect(forSupervisor.hiddenCount).toBe(0);
      expect(forSupervisor.visible.map((m) => m.displayName)).toContain('Farida Sheikh');
    });

    it('ignores records already folded into another', async () => {
      const original = await register(workerA(), org.villageAId, {
        first_name: 'Vimala',
        last_name: 'Reddy',
      });
      const copy = await register(workerA(), org.villageAId, {
        first_name: 'Vimala',
        last_name: 'Reddy',
      });
      await asUser(admin(), (tx) =>
        markAsDuplicate(tx, { subjectId: copy, canonicalId: original, markedBy: org.adminId }),
      );

      const result = await check(org.workerAId, 'field_worker', {
        first_name: 'Vimala',
        last_name: 'Reddy',
      });

      // Pointing the worker at a record that is no longer the one in use would
      // undo the linking.
      expect(result.visible.map((m) => m.id)).toEqual([original]);
    });

    it('asks nothing when there is nothing to go on', async () => {
      const result = await check(org.workerAId, 'field_worker', { first_name: 'Om' });
      // Two characters and no identifying answer: comparing that against every
      // name in the organisation produces noise, not warnings.
      expect(result).toEqual({ visible: [], hiddenCount: 0 });
    });

    it('never looks into another organisation', async () => {
      const other = await createTestOrg('registry-other');
      try {
        const otherForm = await publishForm(
          other,
          'child_registration',
          [{ key: 'first_name', dataType: 'text' }, { key: 'last_name', dataType: 'text' }],
          { formType: 'registration', displayNameFields: ['first_name', 'last_name'] },
        );
        await ownerDb().insert(subjects).values({
          orgId: other.id,
          subjectTypeId: otherForm.subjectTypeId,
          displayName: 'Bhagyalakshmi Iyer',
          attributes: {},
          locationId: other.villageAId,
          createdBy: other.workerAId,
        });

        // RLS is bypassed here, so the org scope in the query is the only thing
        // standing between two NGOs' beneficiary lists.
        const result = await check(org.workerAId, 'field_worker', {
          first_name: 'Bhagyalakshmi',
          last_name: 'Iyer',
        });
        expect(result).toEqual({ visible: [], hiddenCount: 0 });
      } finally {
        await dropTestOrg(other);
      }
    });
  });

  describe('duplicate linking', () => {
    it('hides the duplicate from search and points it at the original', async () => {
      const original = await register(workerA(), org.villageAId, {
        first_name: 'Rekha',
        last_name: 'Yadav',
      });
      const copy = await register(workerA(), org.villageAId, {
        first_name: 'Rekha',
        last_name: 'Yadav',
      });

      const linked = await asUser(admin(), (tx) =>
        markAsDuplicate(tx, { subjectId: copy, canonicalId: original, markedBy: org.adminId }),
      );
      expect(linked.ok).toBe(true);

      const results = await asUser(workerA(), (tx) => searchSubjects(tx, { query: 'Rekha Yadav' }));
      expect(results.map((r) => r.id)).toEqual([original]);

      // Nothing is deleted: a wrongly-linked beneficiary must be recoverable,
      // and their answers are still readable from the profile.
      const stillThere = await asUser(workerA(), (tx) => getSubject(tx, copy));
      expect(stillThere?.duplicateOfId).toBe(original);
      expect(stillThere?.attributes).toMatchObject({ first_name: 'Rekha' });

      const canonical = await asUser(workerA(), (tx) => getSubject(tx, original));
      expect(canonical?.duplicates.map((d) => d.id)).toEqual([copy]);
    });

    it('restores the record when the link is undone', async () => {
      const original = await register(workerA(), org.villageAId, {
        first_name: 'Geeta',
        last_name: 'Bai',
      });
      const copy = await register(workerA(), org.villageAId, {
        first_name: 'Geeta',
        last_name: 'Bai',
      });

      await asUser(admin(), (tx) =>
        markAsDuplicate(tx, { subjectId: copy, canonicalId: original, markedBy: org.adminId }),
      );
      await asUser(admin(), (tx) => unmarkDuplicate(tx, copy));

      const results = await asUser(workerA(), (tx) => searchSubjects(tx, { query: 'Geeta Bai' }));
      expect(results.map((r) => r.id).sort()).toEqual([original, copy].sort());
    });

    it('refuses to build a chain from the other end too', async () => {
      /*
       * The order the existing test never tried, and the one that worked.
       * Marking C a duplicate of B and *then* B a duplicate of A both passed
       * the checks — the first because B was canonical at the time, the second
       * because nothing looked at what was already folded into B. The result
       * was C → B → A, with C orphaned behind a record that is no longer the
       * real one: `searchSubjects` hides both, and `getSubject(A)` lists only B.
       */
      const a = await register(workerA(), org.villageAId, { first_name: 'Bela', last_name: 'One' });
      const b = await register(workerA(), org.villageAId, { first_name: 'Bela', last_name: 'Two' });
      const c = await register(workerA(), org.villageAId, {
        first_name: 'Bela',
        last_name: 'Three',
      });

      // c -> b, which is fine on its own: b is canonical.
      expect(
        await asUser(admin(), (tx) =>
          markAsDuplicate(tx, { subjectId: c, canonicalId: b, markedBy: org.adminId }),
        ),
      ).toEqual({ ok: true });

      // Now b -> a. It would take c with it.
      const chained = await asUser(admin(), (tx) =>
        markAsDuplicate(tx, { subjectId: b, canonicalId: a, markedBy: org.adminId }),
      );
      expect(chained).toEqual({
        ok: false,
        reason: expect.stringContaining('already marked as duplicates of this one'),
      });

      const [row] = await ownerDb()
        .select({ duplicateOfId: subjects.duplicateOfId })
        .from(subjects)
        .where(eq(subjects.id, b))
        .limit(1);
      expect(row?.duplicateOfId).toBeNull();
    });

    it('refuses to build a chain of duplicates', async () => {
      const a = await register(workerA(), org.villageAId, { first_name: 'Asha', last_name: 'One' });
      const b = await register(workerA(), org.villageAId, { first_name: 'Asha', last_name: 'Two' });
      const c = await register(workerA(), org.villageAId, { first_name: 'Asha', last_name: 'Three' });

      await asUser(admin(), (tx) =>
        markAsDuplicate(tx, { subjectId: b, canonicalId: a, markedBy: org.adminId }),
      );

      // b -> a already. Pointing c at b would make "which is the real record?"
      // depend on how far you walk, and reporting would have to walk it.
      const chained = await asUser(admin(), (tx) =>
        markAsDuplicate(tx, { subjectId: c, canonicalId: b, markedBy: org.adminId }),
      );
      expect(chained).toEqual({ ok: false, reason: expect.stringContaining('itself marked') });

      const [row] = await ownerDb()
        .select({ duplicateOfId: subjects.duplicateOfId })
        .from(subjects)
        .where(eq(subjects.id, c))
        .limit(1);
      expect(row?.duplicateOfId).toBeNull();
    });

    it('refuses to mark a record as a duplicate of itself', async () => {
      const a = await register(workerA(), org.villageAId, { first_name: 'Nita', last_name: 'Solo' });

      const result = await asUser(admin(), (tx) =>
        markAsDuplicate(tx, { subjectId: a, canonicalId: a, markedBy: org.adminId }),
      );
      expect(result.ok).toBe(false);
    });
  });
});
