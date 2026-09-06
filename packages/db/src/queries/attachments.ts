import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { DbLike } from '../client';
import { attachments } from '../schema/data';

/**
 * Photos, documents and signatures.
 *
 * The bytes live in object storage; this is the row that says whose they are,
 * which question they answer and where to find them. Every function here takes
 * a transaction from `withContext`, so Row-Level Security has already confined
 * it to one organisation — none of them filter by `orgId` themselves.
 *
 * The lifecycle is deliberately two-step, because a phone is not a reliable
 * client. A file is uploaded and its row written *before* the submission
 * carrying it exists — the worker may still be three questions from the end, and
 * may never finish. So a row starts with `submissionId` null and is claimed when
 * the submission lands. What is never claimed is an orphan, and
 * `deleteOrphanedAttachments` reclaims it.
 */

export interface AttachmentRecord {
  id: string;
  fieldKey: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string | null;
  submissionId: string | null;
  createdAt: Date;
}

export interface NewAttachment {
  /**
   * Chosen by the caller, not the database.
   *
   * The storage key contains the id, so the caller needs it before the row
   * exists — otherwise this is an insert followed by an update to fill in where
   * the bytes went, and a crash in between leaves a row pointing nowhere.
   */
  id: string;
  orgId: string;
  fieldKey: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename?: string | null;
  uploadedBy: string;
}

/** Records an intended upload and returns the row. The bytes follow. */
export async function createAttachment(
  db: DbLike,
  attachment: NewAttachment,
): Promise<AttachmentRecord> {
  const [row] = await db
    .insert(attachments)
    .values({
      id: attachment.id,
      orgId: attachment.orgId,
      fieldKey: attachment.fieldKey,
      storageKey: attachment.storageKey,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      originalFilename: attachment.originalFilename ?? null,
      uploadedBy: attachment.uploadedBy,
    })
    .returning();

  // An insert with no conflict clause either returns a row or throws, but the
  // types cannot know that.
  if (!row) throw new Error('attachment insert returned nothing');
  return toRecord(row);
}

export async function getAttachment(db: DbLike, id: string): Promise<AttachmentRecord | null> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return row ? toRecord(row) : null;
}

export async function getAttachments(db: DbLike, ids: string[]): Promise<AttachmentRecord[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(attachments).where(inArray(attachments.id, ids));
  return rows.map(toRecord);
}

/**
 * Ties uploaded files to the submission that references them.
 *
 * Only unclaimed rows are touched. An id that already belongs to another
 * submission is left alone rather than moved: a client that replayed somebody
 * else's attachment id must not be able to steal the file, and the worst it can
 * achieve is a reference that resolves to nothing it is allowed to read.
 *
 * Returns how many were actually claimed, which is what lets the caller notice
 * that a submission referenced a file it does not own.
 */
export async function claimAttachments(
  db: DbLike,
  ids: string[],
  submissionId: string,
  subjectId: string | null,
): Promise<number> {
  if (ids.length === 0) return 0;

  const claimed = await db
    .update(attachments)
    .set({ submissionId, subjectId })
    .where(and(inArray(attachments.id, ids), isNull(attachments.submissionId)))
    .returning({ id: attachments.id });

  return claimed.length;
}

/** Every attachment belonging to a submission, for display or for erasure. */
export async function listAttachmentsForSubmission(
  db: DbLike,
  submissionId: string,
): Promise<AttachmentRecord[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.submissionId, submissionId));
  return rows.map(toRecord);
}

/**
 * Uploads that no submission ever claimed.
 *
 * A worker who photographs a form and then abandons it leaves bytes behind, and
 * nothing else will ever refer to them. The age cutoff is what keeps this from
 * deleting a file belonging to a submission still being filled in — a form can
 * legitimately take a long time.
 */
export async function findOrphanedAttachments(
  db: DbLike,
  olderThan: Date,
): Promise<AttachmentRecord[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(and(isNull(attachments.submissionId), lt(attachments.createdAt, olderThan)));
  return rows.map(toRecord);
}

/**
 * Removes rows by id.
 *
 * The caller deletes the objects; this only forgets where they were. Done in
 * that order deliberately — a row with no object is a broken image, while an
 * object with no row is unreachable bytes nobody can find.
 */
export async function deleteAttachments(db: DbLike, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const removed = await db
    .delete(attachments)
    .where(inArray(attachments.id, ids))
    .returning({ id: attachments.id });
  return removed.length;
}

function toRecord(row: typeof attachments.$inferSelect): AttachmentRecord {
  return {
    id: row.id,
    fieldKey: row.fieldKey,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    originalFilename: row.originalFilename,
    submissionId: row.submissionId,
    createdAt: row.createdAt,
  };
}
