/**
 * Tenant and location isolation, verified against the database.
 *
 * These assertions go through the `mis_app` role — the same non-owner,
 * non-superuser connection that serves every request — so what they prove is
 * that the policies hold, not that some application code remembered a WHERE
 * clause. A regression here is a data breach, which is why they exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database, type RequestContext } from '../client';
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

describe.skipIf(!hasDatabase)('row-level security', () => {
  let appClient: postgres.Sql;
  let appDb: Database;
  let orgA: TestOrg;
  let orgB: TestOrg;
  let formA: string;
  let formB: string;

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

  const countSubmissions = async (context: RequestContext) =>
    asUser(context, async (tx) => {
      const rows = (await tx.execute(
        sql`select id, data->>'note' as note from submissions`,
      )) as unknown as { id: string; note: string }[];
      return rows;
    });

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    orgA = await createTestOrg('rls-a');
    orgB = await createTestOrg('rls-b');

    ({ formId: formA } = await publishForm(orgA, 'notes', [{ key: 'note', dataType: 'short_text' }]));
    ({ formId: formB } = await publishForm(orgB, 'notes', [{ key: 'note', dataType: 'short_text' }]));

    const [versionA] = (await ownerDb().execute(
      sql`select id from form_versions where form_id = ${formA} limit 1`,
    )) as unknown as { id: string }[];
    const [versionB] = (await ownerDb().execute(
      sql`select id from form_versions where form_id = ${formB} limit 1`,
    )) as unknown as { id: string }[];

    await ownerDb()
      .insert(submissions)
      .values([
        // Org A, Village A, by worker A
        {
          orgId: orgA.id,
          formId: formA,
          formVersionId: versionA!.id,
          locationId: orgA.villageAId,
          submittedBy: orgA.workerAId,
          clientUuid: crypto.randomUUID(),
          data: { note: 'A/villageA/workerA' },
        },
        // Org A, Village B, by worker B
        {
          orgId: orgA.id,
          formId: formA,
          formVersionId: versionA!.id,
          locationId: orgA.villageBId,
          submittedBy: orgA.workerBId,
          clientUuid: crypto.randomUUID(),
          data: { note: 'A/villageB/workerB' },
        },
        // A different tenant entirely
        {
          orgId: orgB.id,
          formId: formB,
          formVersionId: versionB!.id,
          locationId: orgB.villageAId,
          submittedBy: orgB.workerAId,
          clientUuid: crypto.randomUUID(),
          data: { note: 'B/villageA/workerA' },
        },
      ]);
  });

  afterAll(async () => {
    await appClient.end();
    await dropTestOrg(orgA);
    await dropTestOrg(orgB);
    await closeHarness();
  });

  it('never returns another organisation\'s rows', async () => {
    const rows = await countSubmissions({
      orgId: orgA.id,
      userId: orgA.adminId,
      role: 'org_admin',
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.note.startsWith('A/'))).toBe(true);
  });

  it('returns nothing when no context is set', async () => {
    // The failure direction that matters: a code path that forgets to set the
    // tenant shows an empty screen, never someone else's data.
    const rows = (await appDb.execute(
      sql`select id from submissions`,
    )) as unknown as unknown[];

    expect(rows).toHaveLength(0);
  });

  it('cannot be tricked into reading another tenant by asking for its org id', async () => {
    // Simulates a tampered session claiming org B while holding an org A user.
    // The rows returned belong to whatever org the context names, so the
    // protection that matters is that the session itself is signed — but the
    // policy must at minimum never return a *union* of both.
    const rows = await countSubmissions({
      orgId: orgB.id,
      userId: orgA.adminId,
      role: 'org_admin',
    });

    expect(rows.every((r) => r.note.startsWith('B/'))).toBe(true);
  });

  it('shows a field worker only their own submissions', async () => {
    const rows = await countSubmissions({
      orgId: orgA.id,
      userId: orgA.workerAId,
      role: 'field_worker',
    });

    expect(rows.map((r) => r.note)).toEqual(['A/villageA/workerA']);
  });

  it('shows a supervisor everything in their assigned subtree', async () => {
    // The supervisor is assigned the district; ltree containment should give
    // them both villages without an explicit assignment to either.
    const rows = await countSubmissions({
      orgId: orgA.id,
      userId: orgA.supervisorId,
      role: 'supervisor',
    });

    expect(rows).toHaveLength(2);
  });

  it('stops a field worker from writing a submission attributed to someone else', async () => {
    const [version] = (await ownerDb().execute(
      sql`select id from form_versions where form_id = ${formA} limit 1`,
    )) as unknown as { id: string }[];

    await expect(
      asUser({ orgId: orgA.id, userId: orgA.workerAId, role: 'field_worker' }, (tx) =>
        tx.insert(submissions).values({
          orgId: orgA.id,
          formId: formA,
          formVersionId: version!.id,
          locationId: orgA.villageAId,
          // Attributing the record to a colleague.
          submittedBy: orgA.workerBId,
          clientUuid: crypto.randomUUID(),
          data: { note: 'forged' },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('stops a write into another organisation', async () => {
    const [version] = (await ownerDb().execute(
      sql`select id from form_versions where form_id = ${formB} limit 1`,
    )) as unknown as { id: string }[];

    await expect(
      asUser({ orgId: orgA.id, userId: orgA.adminId, role: 'org_admin' }, (tx) =>
        tx.insert(submissions).values({
          orgId: orgB.id,
          formId: formB,
          formVersionId: version!.id,
          submittedBy: orgB.workerAId,
          clientUuid: crypto.randomUUID(),
          data: { note: 'cross-tenant write' },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('scopes users, locations and forms to the organisation', async () => {
    const counts = await asUser(
      { orgId: orgA.id, userId: orgA.adminId, role: 'org_admin' },
      async (tx) => {
        const [row] = (await tx.execute(sql`
          select
            (select count(*) from users)         as users,
            (select count(*) from locations)     as locations,
            (select count(*) from forms)         as forms,
            (select count(*) from organisations) as orgs
        `)) as unknown as Record<string, number>[];
        return row!;
      },
    );

    expect(Number(counts.users)).toBe(4);
    expect(Number(counts.locations)).toBe(3);
    expect(Number(counts.forms)).toBe(1);
    expect(Number(counts.orgs)).toBe(1);
  });

  it('hides API keys from non-admins', async () => {
    await ownerDb().execute(sql`
      insert into api_keys (org_id, name, key_prefix, key_hash)
      values (${orgA.id}, 'test', 'mis_ab', ${'hash-' + crypto.randomUUID()})
    `);

    const asAdmin = await asUser(
      { orgId: orgA.id, userId: orgA.adminId, role: 'org_admin' },
      async (tx) => (await tx.execute(sql`select id from api_keys`)) as unknown as unknown[],
    );
    const asWorker = await asUser(
      { orgId: orgA.id, userId: orgA.workerAId, role: 'field_worker' },
      async (tx) => (await tx.execute(sql`select id from api_keys`)) as unknown as unknown[],
    );

    expect(asAdmin.length).toBe(1);
    expect(asWorker.length).toBe(0);
  });

  it('stops a field worker deleting what only an administrator may write', async () => {
    /*
     * The gap: these policies put the role check in `WITH CHECK`, which governs
     * INSERT and UPDATE — and **DELETE consults `USING` alone**. So `UPDATE
     * purposes` was correctly refused while `DELETE FROM purposes` succeeded,
     * and an organisation's purposes, notices and branding could be destroyed
     * by any signed-in worker. Only the application's own `requireRole` guards
     * stood behind it, which inverts this file's stated premise.
     *
     * The role predicate could not simply move into `USING`: that also governs
     * SELECT, and every field worker has to read purposes and notices to render
     * the consent screen. The last assertion here is what pins that down.
     */
    await ownerDb().execute(sql`
      INSERT INTO purposes (org_id, code, name, lawful_basis)
      VALUES (${orgA.id}, 'rls_delete_probe', '{"en":"probe"}'::jsonb, 'consent')
    `);

    const deletedByWorker = await asUser(
      { orgId: orgA.id, userId: orgA.workerAId, role: 'field_worker' },
      async (tx) =>
        (
          (await tx.execute(
            sql`DELETE FROM purposes WHERE code = 'rls_delete_probe' RETURNING id`,
          )) as unknown as unknown[]
        ).length,
    );
    expect(deletedByWorker).toBe(0);

    // Reading is untouched — the consent screen needs it.
    const visible = await asUser(
      { orgId: orgA.id, userId: orgA.workerAId, role: 'field_worker' },
      async (tx) =>
        (
          (await tx.execute(
            sql`select id from purposes where code = 'rls_delete_probe'`,
          )) as unknown as unknown[]
        ).length,
    );
    expect(visible).toBe(1);

    // And an administrator can still do it.
    const deletedByAdmin = await asUser(
      { orgId: orgA.id, userId: orgA.adminId, role: 'org_admin' },
      async (tx) =>
        (
          (await tx.execute(
            sql`DELETE FROM purposes WHERE code = 'rls_delete_probe' RETURNING id`,
          )) as unknown as unknown[]
        ).length,
    );
    expect(deletedByAdmin).toBe(1);
  });

  it('confirms the application role cannot bypass RLS', async () => {
    const [row] = (await appDb.execute(sql`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user
    `)) as unknown as { rolsuper: boolean; rolbypassrls: boolean }[];

    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
  });
});
