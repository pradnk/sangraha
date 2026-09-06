/**
 * The two foundations everything else in DPDP compliance rests on: an
 * organisation that can say who it is, and an audit trail that cannot be
 * rewritten.
 *
 * Both are load-bearing in the same way — they are what a claim of compliance
 * is checked against later. A grievance route nobody filled in and a revision
 * log the audited party can edit both look fine on screen and prove nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database } from '../client';
import {
  getOrgIdentity,
  missingForNotice,
  updateOrgIdentity,
  type OrgIdentity,
} from '../queries/organisation-identity';
import {
  accessTouchingSubject,
  listAccessEvents,
  recordAccess,
} from '../queries/access-log';
import { subjects, submissionRevisions, submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

/** An identity with nothing filled in — the state every existing org starts in. */
const EMPTY: OrgIdentity = {
  legalName: null,
  entityType: null,
  registrationNumber: null,
  registeredAddress: null,
  grievanceOfficerName: null,
  grievanceOfficerEmail: null,
  grievanceOfficerPhone: null,
  dpoName: null,
  dpoEmail: null,
  dataRegion: 'IN',
  isSignificantDataFiduciary: false,
};

const COMPLETE: OrgIdentity = {
  ...EMPTY,
  legalName: 'Dharti Foundation',
  registeredAddress: '12 MG Road, Belagavi',
  grievanceOfficerName: 'Sunita Devi',
  grievanceOfficerPhone: '9876543210',
};

describe('what a notice needs before it can be published', () => {
  /*
   * Unit tests, no database. This is the gate that stops an organisation
   * publishing a privacy notice that names nobody and offers no way to
   * complain, so what it demands — and what it deliberately does not — is
   * worth pinning down.
   */
  it('asks for the things a notice cannot be written without', () => {
    expect(missingForNotice(EMPTY)).toEqual(
      expect.arrayContaining(['legalName', 'registeredAddress', 'grievanceOfficerName']),
    );
  });

  it('is satisfied by a phone number alone', () => {
    // Most NGOs here will give a phone. Insisting on email would exclude
    // exactly the organisations that need this most.
    expect(missingForNotice(COMPLETE)).toEqual([]);
    expect(
      missingForNotice({
        ...COMPLETE,
        grievanceOfficerPhone: null,
        grievanceOfficerEmail: 'grievance@dharti.org',
      }),
    ).toEqual([]);
  });

  it('refuses a grievance officer with no way to reach them', () => {
    const unreachable = { ...COMPLETE, grievanceOfficerPhone: null };
    expect(missingForNotice(unreachable)).toContain('grievanceOfficerEmail');
  });

  it('does not demand a DPO of an ordinary organisation', () => {
    // Only a Significant Data Fiduciary must appoint one. Demanding it of a
    // four-person NGO teaches them that compliance is theatre.
    expect(missingForNotice(COMPLETE)).not.toContain('dpoName');
    expect(missingForNotice({ ...COMPLETE, isSignificantDataFiduciary: true })).toEqual(['dpoName']);
  });

  it('treats whitespace as absent', () => {
    expect(missingForNotice({ ...COMPLETE, legalName: '   ' })).toContain('legalName');
  });
});

describe.skipIf(!hasDatabase)('organisation identity', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('identity');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('starts empty, and defaults to keeping data in India', async () => {
    const identity = await getOrgIdentity(ownerDb(), org.id);

    expect(identity?.legalName).toBeNull();
    expect(identity?.grievanceOfficerName).toBeNull();
    /*
     * The default that matters. Section 16 is permissive, but the government
     * agreements behind most scheme-delivery work are not, and an organisation
     * that never opens this screen should not silently be exporting children's
     * data.
     */
    expect(identity?.dataRegion).toBe('IN');
    expect(identity?.isSignificantDataFiduciary).toBe(false);
  });

  it('saves and reads back what was entered', async () => {
    await updateOrgIdentity(ownerDb(), org.id, {
      legalName: 'Dharti Foundation',
      entityType: 'Public charitable trust',
      registrationNumber: 'E-12345',
      registeredAddress: '12 MG Road, Belagavi',
      grievanceOfficerName: 'Sunita Devi',
      grievanceOfficerPhone: '9876543210',
    });

    const identity = await getOrgIdentity(ownerDb(), org.id);
    expect(identity?.legalName).toBe('Dharti Foundation');
    expect(identity?.grievanceOfficerPhone).toBe('9876543210');
    expect(missingForNotice(identity!)).toEqual([]);
  });

  it('does not touch another organisation', async () => {
    const other = await createTestOrg('identity-other');
    try {
      await updateOrgIdentity(ownerDb(), org.id, { legalName: 'Changed' });
      expect((await getOrgIdentity(ownerDb(), other.id))?.legalName).toBeNull();
    } finally {
      await dropTestOrg(other);
    }
  });
});

describe.skipIf(!hasDatabase)('the revision log is append-only', () => {
  /*
   * `submission_revisions` has described itself as append-only since it was
   * written, while `030-grants.sql` handed the request role UPDATE and DELETE
   * on every table in `public`. These tests are the difference between a
   * comment and a guarantee, so they run against the real `mis_app` connection
   * — asserting through the owner connection would prove nothing, because the
   * owner is exempt by design.
   */
  let appClient: postgres.Sql;
  let appDb: Database;
  let org: TestOrg;
  let revisionId: string;

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 2);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('immutable');
    const form = await publishForm(org, 'notes', [{ key: 'note', dataType: 'short_text' }]);

    const [submission] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId: form.formId,
        formVersionId: form.versionId,
        locationId: org.villageAId,
        data: { note: 'as captured' },
        status: 'submitted',
        submittedBy: org.workerAId,
        clientUuid: crypto.randomUUID(),
      })
      .returning({ id: submissions.id });

    const [revision] = await ownerDb()
      .insert(submissionRevisions)
      .values({
        submissionId: submission!.id,
        revisionNo: 1,
        changeType: 'created',
        status: 'submitted',
        data: { note: 'as captured' },
        changedBy: org.workerAId,
      })
      .returning({ id: submissionRevisions.id });

    revisionId = revision!.id;
  });

  afterAll(async () => {
    await appClient.end();
    await dropTestOrg(org);
    await closeHarness();
  });

  it('refuses the request role outright, by privilege', async () => {
    // Not the trigger — `mis_app` holds no UPDATE or DELETE privilege here at
    // all, so a bug in request code cannot reach these rows however hard it
    // tries. This is the boundary that matters, because `mis_app` serves 100%
    // of normal operation.
    await expect(
      appDb.execute(sql`UPDATE submission_revisions SET reason = 'rewritten' WHERE id = ${revisionId}`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      appDb.execute(sql`DELETE FROM submission_revisions WHERE id = ${revisionId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses even the owner, unless the owner says it meant to', async () => {
    // The owner is the table owner and exempt from privileges, so this one is
    // the trigger. It cannot stop an operator who means it — nothing can — but
    // it stops an operator who did not realise.
    await expect(
      ownerDb().execute(sql`UPDATE submission_revisions SET reason = 'rewritten' WHERE id = ${revisionId}`),
    ).rejects.toThrow(/append-only/i);
  });

  it('lets a declared purge through, which is how an organisation is deleted', async () => {
    /*
     * Rolled back, so the fixture survives. `submission_revisions` cascades
     * from `submissions`, and a row trigger fires on a cascade too — so
     * without this escape hatch, adding the trigger would have quietly broken
     * `deleteOrganisation` and every test that tears an org down.
     */
    await expect(
      ownerDb().transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.allow_purge', 'on', true)`);
        await tx.execute(sql`DELETE FROM submission_revisions WHERE id = ${revisionId}`);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const [still] = await ownerDb()
      .select({ id: submissionRevisions.id })
      .from(submissionRevisions)
      .where(eq(submissionRevisions.id, revisionId));
    expect(still).toBeDefined();
  });

  it('does not leak the purge flag to the next transaction', async () => {
    // `SET LOCAL` rather than `SET`, because the pool hands this connection to
    // somebody else next.
    await ownerDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.allow_purge', 'on', true)`);
    });

    await expect(
      ownerDb().execute(sql`DELETE FROM submission_revisions WHERE id = ${revisionId}`),
    ).rejects.toThrow(/append-only/i);
  });

  it('still lets the log be appended to', async () => {
    // The point is immutability, not read-only. A correction is a new row.
    const [added] = await ownerDb()
      .insert(submissionRevisions)
      .values({
        submissionId: (
          await ownerDb()
            .select({ id: submissionRevisions.submissionId })
            .from(submissionRevisions)
            .where(eq(submissionRevisions.id, revisionId))
        )[0]!.id,
        revisionNo: 2,
        changeType: 'updated',
        status: 'submitted',
        data: { note: 'corrected' },
        changedBy: org.workerAId,
      })
      .returning({ id: submissionRevisions.id });

    expect(added).toBeDefined();
  });
});

describe.skipIf(!hasDatabase)('the access log', () => {
  /*
   * Everything here runs through the real `mis_app` connection with a role set,
   * because the properties under test are the RLS policies — asserting them on
   * the owner connection would prove nothing.
   */
  let appClient: postgres.Sql;
  let appDb: Database;
  let org: TestOrg;
  let subjectId: string;

  async function as<T>(
    context: { userId: string; role: string },
    work: (tx: Database) => Promise<T>,
  ): Promise<T> {
    return appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
      await tx.execute(sql`select set_config('app.role', ${context.role}, true)`);
      return work(tx as unknown as Database);
    });
  }

  const admin = () => ({ userId: org.adminId, role: 'org_admin' });
  const worker = () => ({ userId: org.workerAId, role: 'field_worker' });

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 2);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('accesslog');
    const registration = await publishForm(org, 'people', [{ key: 'name', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });

    const [created] = await ownerDb()
      .insert(subjects)
      .values({
        orgId: org.id,
        subjectTypeId: registration.subjectTypeId,
        displayName: 'Sunita Devi',
        attributes: {},
        locationId: org.villageAId,
        createdBy: org.workerAId,
      })
      .returning({ id: subjects.id });
    subjectId = created!.id;
  });

  afterAll(async () => {
    await appClient.end();
    await dropTestOrg(org);
    await closeHarness();
  });

  it('records who did what', async () => {
    await as(worker(), (tx) =>
      recordAccess(
        tx,
        { orgId: org.id, userId: org.workerAId, username: 'worker_a', role: 'field_worker' },
        { action: 'view_subject', targetType: 'subject', targetId: subjectId, rowCount: 1 },
      ),
    );

    const [entry] = await as(admin(), (tx) => listAccessEvents(tx, { action: 'view_subject' }));

    expect(entry).toMatchObject({
      action: 'view_subject',
      targetId: subjectId,
      rowCount: 1,
      actorUsername: 'worker_a',
    });
    // Joined live, so the log reads with today's name rather than a stale one.
    expect(entry?.actorName).toBe('Worker A');
  });

  it('lets everyone write and only an admin read', async () => {
    /*
     * The asymmetry is the point. A field worker has to be able to write — they
     * are the ones searching the registry — but a log they can read tells them
     * which colleague has been checked on, and one they can filter lets them
     * find who else has seen a beneficiary they are not entitled to see.
     */
    await as(worker(), (tx) =>
      recordAccess(
        tx,
        { orgId: org.id, userId: org.workerAId },
        { action: 'search_subjects', rowCount: 3 },
      ),
    );

    expect(await as(worker(), (tx) => listAccessEvents(tx))).toEqual([]);
    expect((await as(admin(), (tx) => listAccessEvents(tx))).length).toBeGreaterThan(0);
  });

  it('will not show one organisation another’s log', async () => {
    const other = await createTestOrg('accesslog-other');
    try {
      const seen = await appDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${other.id}, true)`);
        await tx.execute(sql`select set_config('app.user_id', ${other.adminId}, true)`);
        await tx.execute(sql`select set_config('app.role', 'org_admin', true)`);
        return listAccessEvents(tx as unknown as Database);
      });
      expect(seen).toEqual([]);
    } finally {
      await dropTestOrg(other);
    }
  });

  it('cannot be edited or erased by the request path', async () => {
    // Whoever wants to hide that they looked at something would come through
    // here, so this is the assertion that gives the log its value.
    const [entry] = await as(admin(), (tx) => listAccessEvents(tx));

    await expect(
      appDb.execute(sql`UPDATE access_events SET action = 'sign_in' WHERE id = ${entry!.id}`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      appDb.execute(sql`DELETE FROM access_events WHERE id = ${entry!.id}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('answers "what touched this person"', async () => {
    /*
     * The breach question. A bulk act names nobody, but the person was in it —
     * so an export counts as having touched them, and the report has to say so
     * rather than only listing the times somebody opened their profile.
     */
    await as(admin(), (tx) =>
      recordAccess(
        tx,
        { orgId: org.id, userId: org.adminId },
        { action: 'export_csv', targetType: 'form', rowCount: 400, scope: 'status=approved' },
      ),
    );

    const touching = await as(admin(), (tx) => accessTouchingSubject(tx, org.id, subjectId));
    const actions = touching.map((entry) => entry.action);

    expect(actions).toContain('view_subject');
    expect(actions).toContain('export_csv');

    const exported = touching.find((entry) => entry.action === 'export_csv');
    expect(exported?.rowCount).toBe(400);
    expect(exported?.scope).toBe('status=approved');
  });

  it('reports a failed write instead of throwing', async () => {
    /*
     * A deliberate trade, and the reason the log may have holes: a failed audit
     * insert must not stop a field worker finding a beneficiary.
     *
     * Note what this does *not* buy. Postgres aborts an entire transaction on
     * any failed statement and postgres.js re-raises at the commit boundary, so
     * swallowing the error cannot rescue a caller that shared its transaction —
     * a savepoint was tried and does not change it. The contract is therefore
     * that the log gets a connection of its own, and this swallow is the second
     * line of defence rather than the first.
     */
    const own = drizzle(createPostgresClient(process.env.DATABASE_APP_URL!, 1)) as unknown as Database;

    await expect(
      recordAccess(
        own,
        // An organisation that does not exist: fails the foreign key.
        { orgId: '00000000-0000-4000-8000-000000000000', userId: org.workerAId },
        { action: 'view_subject' },
      ),
    ).resolves.toBeUndefined();

    // And nothing was written.
    const after = await as(admin(), (tx) => listAccessEvents(tx, { action: 'view_subject' }));
    expect(after.every((entry) => entry.targetId !== null || entry.rowCount !== null)).toBe(true);
  });
});
