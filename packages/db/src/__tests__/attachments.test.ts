/**
 * The attachment lifecycle, through the real `mis_app` connection.
 *
 * A file is uploaded before the submission that refers to it exists — the
 * worker may still be three questions from the end, and may never finish. That
 * two-step is where the interesting failures live, and all of them are about
 * ownership: a row must not be claimable by a second submission, must not be
 * visible to another tenant, and must not survive the erasure of the person it
 * depicts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { createPostgresClient, type Database, type RequestContext } from '../client';
import {
  claimAttachments,
  createAttachment,
  deleteAttachments,
  findOrphanedAttachments,
  getAttachment,
  listAttachmentsForSubmission,
} from '../queries/attachments';
import { deleteOrganisation } from '../admin/delete-organisation';
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

describe.skipIf(!hasDatabase)('attachments', () => {
  let appClient: postgres.Sql;
  let appDb: Database;
  let org: TestOrg;
  let other: TestOrg;
  let versionId: string;
  let formId: string;

  async function asUser<T>(context: RequestContext, work: (tx: Database) => Promise<T>) {
    return appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${context.orgId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${context.userId}, true)`);
      await tx.execute(sql`select set_config('app.role', ${context.role}, true)`);
      return work(tx as unknown as Database);
    });
  }

  const worker = (): RequestContext => ({
    orgId: org.id,
    userId: org.workerAId,
    role: 'field_worker',
  });

  async function newSubmission(): Promise<string> {
    const [row] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId,
        formVersionId: versionId,
        data: {},
        status: 'submitted',
        submittedBy: org.workerAId,
        clientUuid: randomUUID(),
      })
      .returning({ id: submissions.id });
    return row!.id;
  }

  function reserve(fieldKey = 'face') {
    const id = randomUUID();
    return {
      id,
      orgId: org.id,
      fieldKey,
      storageKey: `org/${org.id}/${id}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 12_345,
      uploadedBy: org.workerAId,
    };
  }

  beforeAll(async () => {
    appClient = createPostgresClient(process.env.DATABASE_APP_URL!, 4);
    appDb = drizzle(appClient) as unknown as Database;

    org = await createTestOrg('attach');
    other = await createTestOrg('attach-other');
    const published = await publishForm(org, 'visit', [
      { key: 'face', dataType: 'photo' },
      { key: 'scan', dataType: 'file' },
    ]);
    formId = published.formId;
    versionId = published.versionId;
  }, 60_000);

  afterAll(async () => {
    await appClient?.end();
    await dropTestOrg(org);
    await dropTestOrg(other);
    await closeHarness();
  });

  it('records an upload with no submission behind it', async () => {
    const record = await asUser(worker(), (tx) => createAttachment(tx, reserve()));

    // The whole point of the two-step: the row is valid while the form is still
    // being filled in.
    expect(record.submissionId).toBeNull();
    expect(record.fieldKey).toBe('face');
    expect(record.sizeBytes).toBe(12_345);
  });

  it('claims an upload onto the submission that refers to it', async () => {
    const record = await asUser(worker(), (tx) => createAttachment(tx, reserve()));
    const submissionId = await newSubmission();

    const claimed = await asUser(worker(), (tx) =>
      claimAttachments(tx, [record.id], submissionId, null),
    );
    expect(claimed).toBe(1);

    const held = await asUser(worker(), (tx) => listAttachmentsForSubmission(tx, submissionId));
    expect(held.map((a) => a.id)).toEqual([record.id]);
  });

  it('will not let a second submission steal an already-claimed file', async () => {
    /*
     * The attack this closes: a client echoes back an attachment id it saw
     * somewhere else, hoping to attach somebody's photograph to its own record.
     * `claimAttachments` only touches unclaimed rows, so the replay claims
     * nothing and is left with a reference that resolves to a file it cannot
     * read.
     */
    const record = await asUser(worker(), (tx) => createAttachment(tx, reserve()));
    const first = await newSubmission();
    const second = await newSubmission();

    expect(await asUser(worker(), (tx) => claimAttachments(tx, [record.id], first, null))).toBe(1);
    expect(await asUser(worker(), (tx) => claimAttachments(tx, [record.id], second, null))).toBe(0);

    const stillFirst = await asUser(worker(), (tx) => getAttachment(tx, record.id));
    expect(stillFirst?.submissionId).toBe(first);
  });

  it('hides another organisation’s attachment completely', async () => {
    const record = await asUser(worker(), (tx) => createAttachment(tx, reserve()));

    const outsider: RequestContext = {
      orgId: other.id,
      userId: other.workerAId,
      role: 'field_worker',
    };

    // Not "denied" — absent. A guessed uuid must not confirm that a file exists.
    expect(await asUser(outsider, (tx) => getAttachment(tx, record.id))).toBeNull();
    expect(await asUser(outsider, (tx) => claimAttachments(tx, [record.id], randomUUID(), null))).toBe(0);
  });

  it('hides a colleague\u2019s attachment, not just another tenant\u2019s', async () => {
    /*
     * The policy was `org_id = app.current_org_id()` and nothing else, while
     * the download route describes itself as deciding visibility "by the same
     * Row-Level Security that governs every other read". It was not: a field
     * worker restricted to their own submissions could still read any
     * attachment row in the organisation, given its uuid. These are
     * photographs of the people the organisation works with.
     */
    const [theirs] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId,
        formVersionId: versionId,
        locationId: org.villageBId,
        data: {},
        status: 'submitted',
        submittedBy: org.workerBId,
        clientUuid: randomUUID(),
      })
      .returning({ id: submissions.id });

    const record = await asUser(
      { orgId: org.id, userId: org.workerBId, role: 'field_worker' },
      (tx) => createAttachment(tx, { ...reserve(), uploadedBy: org.workerBId }),
    );
    await asUser({ orgId: org.id, userId: org.workerBId, role: 'field_worker' }, (tx) =>
      claimAttachments(tx, [record.id], theirs!.id, null),
    );

    // Worker A knows the uuid and still cannot have it.
    expect(await asUser(worker(), (tx) => getAttachment(tx, record.id))).toBeNull();

    // A supervisor, whose submission policy is by location rather than by
    // submitter, sees it — the attachment inherits, it does not invent.
    const seen = await asUser(
      { orgId: org.id, userId: org.supervisorId, role: 'supervisor' },
      (tx) => getAttachment(tx, record.id),
    );
    expect(seen?.id).toBe(record.id);
  });

  it('keeps an unclaimed upload to the worker who reserved it', async () => {
    // Before it is attached there is no submission to inherit from, so the
    // uploader is the only sensible owner — and an abandoned photo should not
    // be visible to the whole organisation while it waits for the sweeper.
    const record = await asUser(
      { orgId: org.id, userId: org.workerBId, role: 'field_worker' },
      (tx) => createAttachment(tx, { ...reserve(), uploadedBy: org.workerBId }),
    );

    expect(await asUser(worker(), (tx) => getAttachment(tx, record.id))).toBeNull();
    expect(
      (
        await asUser({ orgId: org.id, userId: org.workerBId, role: 'field_worker' }, (tx) =>
          getAttachment(tx, record.id),
        )
      )?.id,
    ).toBe(record.id);
  });

  it('lists uploads nothing ever claimed, but only the old ones', async () => {
    const fresh = await asUser(worker(), (tx) => createAttachment(tx, reserve()));

    // A form legitimately takes a long time to fill in, so "unclaimed" alone is
    // not enough to delete on — an upload from a minute ago belongs to a
    // submission still being written.
    const recentCutoff = new Date(Date.now() - 60_000);
    const notYet = await asUser(worker(), (tx) => findOrphanedAttachments(tx, recentCutoff));
    expect(notYet.map((a) => a.id)).not.toContain(fresh.id);

    const laterCutoff = new Date(Date.now() + 60_000);
    const orphans = await asUser(worker(), (tx) => findOrphanedAttachments(tx, laterCutoff));
    expect(orphans.map((a) => a.id)).toContain(fresh.id);

    // And a claimed one is never an orphan, however old.
    const claimedRecord = await asUser(worker(), (tx) => createAttachment(tx, reserve()));
    const owningSubmission = await newSubmission();
    await asUser(worker(), (tx) =>
      claimAttachments(tx, [claimedRecord.id], owningSubmission, null),
    );
    const after = await asUser(worker(), (tx) => findOrphanedAttachments(tx, laterCutoff));
    expect(after.map((a) => a.id)).not.toContain(claimedRecord.id);
  });

  it('goes when its submission goes', async () => {
    // The row cascades, which is what lets erasure delete submissions without a
    // second statement — and why the objects have to be destroyed first.
    const record = await asUser(worker(), (tx) => createAttachment(tx, reserve()));
    const submissionId = await newSubmission();
    await asUser(worker(), (tx) => claimAttachments(tx, [record.id], submissionId, null));

    await ownerDb().execute(sql`DELETE FROM submissions WHERE id = ${submissionId}::uuid`);

    expect(await asUser(worker(), (tx) => getAttachment(tx, record.id))).toBeNull();
  });

  it('destroys the objects when the whole organisation goes', async () => {
    /*
     * `deleteOrganisation` removed every row and never touched storage. The
     * attachment rows cascade from submissions, and `storage_key` is the only
     * record of where the objects live — so after `org:delete` every
     * photograph and every signature sat in the bucket permanently, unreachable
     * and unfindable. `purgeErasures` had always got this right, which made the
     * whole-tenant path the weaker of the two.
     */
    const doomed = await createTestOrg('attach-doomed');
    const published = await publishForm(doomed, 'visit', [{ key: 'face', dataType: 'photo' }]);

    const [submission] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: doomed.id,
        formId: published.formId,
        formVersionId: published.versionId,
        data: {},
        status: 'submitted',
        submittedBy: doomed.workerAId,
        clientUuid: randomUUID(),
      })
      .returning({ id: submissions.id });

    const id = randomUUID();
    const storageKey = `org/${doomed.id}/${id}.jpg`;
    await ownerDb().execute(sql`
      INSERT INTO attachments (id, org_id, submission_id, field_key, storage_key, mime_type, size_bytes, uploaded_by)
      VALUES (${id}::uuid, ${doomed.id}, ${submission!.id}::uuid, 'face', ${storageKey},
              'image/jpeg', 1234, ${doomed.workerAId}::uuid)
    `);

    const asked: string[] = [];
    const result = await deleteOrganisation(ownerDb(), doomed.id, {
      deleteObject: async (key) => {
        asked.push(key);
        return true;
      },
    });

    expect(asked).toEqual([storageKey]);
    expect(result.attachmentsDeleted).toBe(1);
    expect(result.attachmentsFailed).toBe(0);
  });

  it('reports a file storage would not let go of', async () => {
    // Not swallowed: the rows that named these are about to be destroyed, so
    // nothing will ever find them again. An operator has to be told.
    const doomed = await createTestOrg('attach-doomed2');
    const published = await publishForm(doomed, 'visit', [{ key: 'face', dataType: 'photo' }]);

    const [submission] = await ownerDb()
      .insert(submissions)
      .values({
        orgId: doomed.id,
        formId: published.formId,
        formVersionId: published.versionId,
        data: {},
        status: 'submitted',
        submittedBy: doomed.workerAId,
        clientUuid: randomUUID(),
      })
      .returning({ id: submissions.id });

    const id = randomUUID();
    await ownerDb().execute(sql`
      INSERT INTO attachments (id, org_id, submission_id, field_key, storage_key, mime_type, size_bytes, uploaded_by)
      VALUES (${id}::uuid, ${doomed.id}, ${submission!.id}::uuid, 'face',
              ${`org/${doomed.id}/${id}.jpg`}, 'image/jpeg', 1234, ${doomed.workerAId}::uuid)
    `);

    // No deleter at all, which is the unconfigured-storage case.
    const result = await deleteOrganisation(ownerDb(), doomed.id);

    expect(result.attachmentsDeleted).toBe(0);
    expect(result.attachmentsFailed).toBe(1);
  });

  it('deletes by id and reports how many went', async () => {
    const a = await asUser(worker(), (tx) => createAttachment(tx, reserve()));
    const b = await asUser(worker(), (tx) => createAttachment(tx, reserve()));

    expect(await asUser(worker(), (tx) => deleteAttachments(tx, [a.id, b.id]))).toBe(2);
    expect(await asUser(worker(), (tx) => deleteAttachments(tx, []))).toBe(0);
    expect(await asUser(worker(), (tx) => getAttachment(tx, a.id))).toBeNull();
  });
});
