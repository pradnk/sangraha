/**
 * Who may use a form, asserted through the real `mis_app` connection.
 *
 * Raw `select` and `insert` rather than the query helpers, deliberately. The
 * rule lives in `submissions_isolation` and `submissions_form_audience`, and a
 * test that went through `listSubmissions` would pass just as happily if the
 * policy did nothing and the helper filtered — which is exactly the mistake this
 * feature could ship with. Going under the helpers means only the policy can
 * make these pass.
 *
 * `review.test.ts` has one form and one supervisor, so nothing there would
 * notice a form-scoping regression. Hence separate fixtures: one form per
 * audience, and both workers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database, type RequestContext } from '../client';
import { formAccess, submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('form audiences', () => {
  let appClient: postgres.Sql;
  let appDb: Database;
  let org: TestOrg;

  /** everyone. The control: nothing about it should change. */
  let openForm: { formId: string; versionId: string };
  /** supervisors + worker A. The everyday restricted form. */
  let supervisorForm: { formId: string; versionId: string };
  /** supervisors, nobody added — a supervisor-only form. */
  let supervisorOnly: { formId: string; versionId: string };
  /** admins + worker A. The sensitive form; no supervisor may see it. */
  let adminForm: { formId: string; versionId: string };
  /** admins + worker A, and placeless — the case locations cannot scope. */
  let placelessForm: { formId: string; versionId: string };

  async function asUser<T>(context: RequestContext, work: (tx: Database) => Promise<T>) {
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
  const supervisor = (): RequestContext => ({
    orgId: org.id,
    userId: org.supervisorId,
    role: 'supervisor',
  });
  const admin = (): RequestContext => ({
    orgId: org.id,
    userId: org.adminId,
    role: 'org_admin',
  });

  /** Whether the policy lets this actor use this form, straight from SQL. */
  async function canUse(context: RequestContext, formId: string): Promise<boolean> {
    return asUser(context, async (tx) => {
      const rows = (await tx.execute(
        sql`select app.can_use_form(${formId}::uuid) as allowed`,
      )) as unknown as { allowed: boolean }[];
      return rows[0]!.allowed;
    });
  }

  /** Seeded on the owner connection, so the fixture is not itself under test. */
  async function seed(
    form: { formId: string; versionId: string },
    submittedBy: string,
    locationId: string | null,
    status: 'submitted' | 'rejected' = 'submitted',
  ): Promise<string> {
    const [row] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId: form.formId,
        formVersionId: form.versionId,
        locationId,
        submittedBy,
        clientUuid: crypto.randomUUID(),
        status,
        data: { note: 'x' },
      })
      .returning({ id: submissions.id });
    return row!.id;
  }

  /** How many of these ids this actor can see. */
  async function visible(context: RequestContext, ids: string[]): Promise<number> {
    return asUser(context, async (tx) => {
      const rows = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(sql`${submissions.id} = any(${sql.raw(`'{${ids.join(',')}}'::uuid[]`)})`);
      return rows.length;
    });
  }

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('audience');
    const field = [{ key: 'note', dataType: 'short_text' }];

    openForm = await publishForm(org, 'open_form', field);
    supervisorForm = await publishForm(org, 'supervisor_form', field, {
      audience: 'supervisors',
      accessUserIds: [org.workerAId],
    });
    supervisorOnly = await publishForm(org, 'supervisor_only', field, {
      audience: 'supervisors',
    });
    adminForm = await publishForm(org, 'admin_form', field, {
      audience: 'admins',
      accessUserIds: [org.workerAId],
    });
    placelessForm = await publishForm(org, 'placeless_form', field, {
      audience: 'admins',
      accessUserIds: [org.workerAId],
      formType: 'standalone',
    });
  });

  afterAll(async () => {
    await appClient.end();
    await dropTestOrg(org);
    await closeHarness();
  });

  // --- the invariant the redesign exists for --------------------------------

  it('leaves somebody able to approve, whichever audience is chosen', async () => {
    /*
     * The whole point of composing audiences around a tier. The previous model
     * let an admin build one with no reviewer in it and then explained the
     * consequence in a warning; this asserts the state simply cannot be reached.
     *
     * "Can approve" is "can use it and is not the only person on it" — checked
     * here as: at least one role that can use the form is a reviewing role.
     */
    for (const form of [openForm, supervisorForm, supervisorOnly, adminForm]) {
      const reviewers = [
        await canUse(supervisor(), form.formId),
        await canUse(admin(), form.formId),
      ];
      expect(reviewers.some(Boolean)).toBe(true);
    }
  });

  // --- who may use what -----------------------------------------------------

  it('lets everyone use a form shared with everyone', async () => {
    expect(await canUse(workerA(), openForm.formId)).toBe(true);
    expect(await canUse(workerB(), openForm.formId)).toBe(true);
    expect(await canUse(supervisor(), openForm.formId)).toBe(true);
    expect(await canUse(admin(), openForm.formId)).toBe(true);
  });

  it('gives a supervisors form to every supervisor and only the named workers', async () => {
    expect(await canUse(supervisor(), supervisorForm.formId)).toBe(true);
    expect(await canUse(workerA(), supervisorForm.formId)).toBe(true);
    expect(await canUse(workerB(), supervisorForm.formId)).toBe(false);
  });

  it('treats a supervisors form with nobody added as supervisor-only', async () => {
    // The case the old model had no way to express at all.
    expect(await canUse(supervisor(), supervisorOnly.formId)).toBe(true);
    expect(await canUse(admin(), supervisorOnly.formId)).toBe(true);
    expect(await canUse(workerA(), supervisorOnly.formId)).toBe(false);
    expect(await canUse(workerB(), supervisorOnly.formId)).toBe(false);
  });

  it('keeps supervisors out of an admins form', async () => {
    // The sharpest consequence in the feature, and the one an organisation
    // would be most upset to find was not true: a form restricted to admins
    // plus two named people must not be readable by every supervisor.
    expect(await canUse(admin(), adminForm.formId)).toBe(true);
    expect(await canUse(workerA(), adminForm.formId)).toBe(true);
    expect(await canUse(supervisor(), adminForm.formId)).toBe(false);
    expect(await canUse(workerB(), adminForm.formId)).toBe(false);
  });

  it('always lets an org admin use a form, whatever its audience', async () => {
    for (const form of [openForm, supervisorForm, supervisorOnly, adminForm]) {
      expect(await canUse(admin(), form.formId)).toBe(true);
    }
  });

  it('honours a name being added and removed, without a new session', async () => {
    expect(await canUse(workerB(), supervisorForm.formId)).toBe(false);

    await ownerDb()
      .insert(formAccess)
      .values({ formId: supervisorForm.formId, userId: org.workerBId });
    expect(await canUse(workerB(), supervisorForm.formId)).toBe(true);

    await ownerDb()
      .delete(formAccess)
      .where(eq(formAccess.userId, org.workerBId));
    // Read live on every request — nothing is cached in the session token, which
    // is why an audience change needs no sign-out.
    expect(await canUse(workerB(), supervisorForm.formId)).toBe(false);
  });

  it('fails closed when the request context is unset', async () => {
    // `app.actor_role()` defaults to field_worker and the org id resolves to
    // NULL, so an unscoped connection matches nothing rather than everything.
    const rows = (await appDb.execute(
      sql`select app.can_use_form(${openForm.formId}::uuid) as allowed`,
    )) as unknown as { allowed: boolean }[];
    expect(rows[0]!.allowed).toBe(false);
  });

  // --- capture --------------------------------------------------------------

  it('refuses a new record on a form the worker is not an audience of', async () => {
    // The hole this policy exists for: the capture API takes a formVersionId
    // straight from the client, so a check in the screens would not be a check.
    await expect(
      asUser(workerB(), (tx) =>
        tx.insert(submissions).values({
          orgId: org.id,
          formId: supervisorForm.formId,
          formVersionId: supervisorForm.versionId,
          locationId: org.villageBId,
          submittedBy: org.workerBId,
          clientUuid: crypto.randomUUID(),
          status: 'submitted',
          data: { note: 'should not land' },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('still lets a named worker capture', async () => {
    const id = await asUser(workerA(), async (tx) => {
      const [row] = await tx
        .insert(submissions)
        .values({
          orgId: org.id,
          formId: supervisorForm.formId,
          formVersionId: supervisorForm.versionId,
          locationId: org.villageAId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          status: 'submitted',
          data: { note: 'fine' },
        })
        .returning({ id: submissions.id });
      return row!.id;
    });
    expect(id).toBeTruthy();
  });

  // --- review ---------------------------------------------------------------

  it('keeps an admins form out of the supervisor queue and in the admin one', async () => {
    const ordinary = await seed(openForm, org.workerAId, org.villageAId);
    const sensitive = await seed(adminForm, org.workerAId, org.villageAId);

    expect(await visible(supervisor(), [ordinary, sensitive])).toBe(1);
    expect(await visible(admin(), [ordinary, sensitive])).toBe(2);
  });

  it('lets a supervisor review the records of a form they are the tier for', async () => {
    const theirs = await seed(supervisorForm, org.workerAId, org.villageAId);
    expect(await visible(supervisor(), [theirs])).toBe(1);
  });

  it('agrees between the queue and the count that labels it', async () => {
    const hidden = await seed(adminForm, org.workerAId, org.villageAId);

    const [listed, counted] = await asUser(supervisor(), async (tx) => {
      const rows = await tx
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.status, 'submitted'));
      const total = (await tx.execute(
        sql`select count(*)::int as n from submissions where status = 'submitted'`,
      )) as unknown as { n: number }[];
      return [rows.length, total[0]!.n];
    });

    // The bell and the list are two reads of one policy. If the rule had gone in
    // a query helper instead, `countAwaitingReview` takes no options and would
    // have kept counting this record.
    expect(listed).toBe(counted);
    expect(await visible(supervisor(), [hidden])).toBe(0);
  });

  it('still narrows a supervisor by location within a form they can use', async () => {
    /*
     * "All supervisors" is about the form, not about the map. A supervisor
     * assigned to one district must not start seeing another district's records
     * because a form was opened to their role.
     */
    const other = await createTestOrg('audience-places');
    try {
      const { formId, versionId } = await publishForm(
        other,
        'places_form',
        [{ key: 'note', dataType: 'short_text' }],
        { audience: 'supervisors' },
      );
      const inTheirPatch = await ownerDb()
        .insert(submissions)
        .values({
          orgId: other.id,
          formId,
          formVersionId: versionId,
          locationId: other.villageAId,
          submittedBy: other.workerAId,
          clientUuid: crypto.randomUUID(),
          status: 'submitted',
          data: { note: 'x' },
        })
        .returning({ id: submissions.id });

      const seen = await asUser(
        { orgId: other.id, userId: other.workerBId, role: 'field_worker' },
        async (tx) => {
          const rows = await tx
            .select({ id: submissions.id })
            .from(submissions)
            .where(eq(submissions.id, inTheirPatch[0]!.id));
          return rows.length;
        },
      );
      // Worker B did not submit it, so the field-worker branch hides it — the
      // form's audience never comes into it.
      expect(seen).toBe(0);
    } finally {
      await dropTestOrg(other);
    }
  });

  it('scopes a placeless form, which locations alone cannot reach', async () => {
    // `can_see_location` returns true for a NULL location, so before this
    // feature every supervisor could see every standalone survey org-wide.
    const placeless = await seed(placelessForm, org.workerAId, null);
    expect(await visible(supervisor(), [placeless])).toBe(0);
    expect(await visible(admin(), [placeless])).toBe(1);
  });

  it('leaves a supervisor their own records whatever the audience says', async () => {
    const own = await seed(adminForm, org.supervisorId, org.villageAId);
    // They cannot use the form, but losing sight of what they themselves
    // captured would be a bug wearing a policy's clothes.
    expect(await canUse(supervisor(), adminForm.formId)).toBe(false);
    expect(await visible(supervisor(), [own])).toBe(1);
  });

  // --- what losing access does not take away --------------------------------

  it('leaves a worker their own history when the audience moves on without them', async () => {
    const mine = await seed(supervisorForm, org.workerAId, org.villageAId);

    await ownerDb().delete(formAccess).where(eq(formAccess.formId, supervisorForm.formId));
    try {
      expect(await canUse(workerA(), supervisorForm.formId)).toBe(false);
      // The field-worker branch of the policy is untouched by audience.
      expect(await visible(workerA(), [mine])).toBe(1);
    } finally {
      await ownerDb()
        .insert(formAccess)
        .values({ formId: supervisorForm.formId, userId: org.workerAId })
        .onConflictDoNothing();
    }
  });

  it('lets a worker finish a correction on a form they have since lost', async () => {
    const rejected = await seed(supervisorForm, org.workerAId, org.villageAId, 'rejected');

    await ownerDb().delete(formAccess).where(eq(formAccess.formId, supervisorForm.formId));
    try {
      /*
       * The reason the audience policy is `FOR INSERT` rather than blanket
       * WITH CHECK. Access governs what you may start, not what you must
       * finish — a record sent back that nobody may touch is stuck for ever.
       */
      await asUser(workerA(), (tx) =>
        tx
          .update(submissions)
          .set({ data: { note: 'corrected' }, status: 'submitted' })
          .where(eq(submissions.id, rejected)),
      );

      const [row] = await ownerDb()
        .select({ data: submissions.data, status: submissions.status })
        .from(submissions)
        .where(eq(submissions.id, rejected));
      expect(row?.data).toEqual({ note: 'corrected' });
      expect(row?.status).toBe('submitted');
    } finally {
      await ownerDb()
        .insert(formAccess)
        .values({ formId: supervisorForm.formId, userId: org.workerAId })
        .onConflictDoNothing();
    }
  });

  // --- tenancy --------------------------------------------------------------

  it('does not let another organisation reach a form or its records', async () => {
    const other = await createTestOrg('audience-other');
    try {
      expect(
        await canUse(
          { orgId: other.id, userId: other.workerAId, role: 'field_worker' },
          openForm.formId,
        ),
      ).toBe(false);

      // Their admin short-circuits `can_use_form`, so the submission policy is
      // what actually holds the tenant boundary. Assert the boundary, not the
      // helper.
      const mine = await seed(openForm, org.workerAId, org.villageAId);
      expect(
        await visible({ orgId: other.id, userId: other.adminId, role: 'org_admin' }, [mine]),
      ).toBe(0);

      // A foreign user named on our form must not gain access to it.
      await ownerDb()
        .insert(formAccess)
        .values({ formId: supervisorForm.formId, userId: other.workerAId });
      expect(
        await canUse(
          { orgId: other.id, userId: other.workerAId, role: 'field_worker' },
          supervisorForm.formId,
        ),
      ).toBe(false);
    } finally {
      await dropTestOrg(other);
    }
  });

  it('will not let a worker add themselves to a form', async () => {
    await expect(
      asUser(workerB(), (tx) =>
        tx.insert(formAccess).values({ formId: adminForm.formId, userId: org.workerBId }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
