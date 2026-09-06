'use client';

import { deletePending, getPending, putPending } from './attachment-store';

/**
 * Getting a captured file to the server.
 *
 * Two steps, because the bytes do not travel through our own API: `/api/attachments`
 * decides whether the upload is allowed and hands back a row id and a
 * short-lived URL, and the browser PUTs to object storage directly. See the
 * route for why.
 *
 * Offline, neither step is possible — so the file is parked in IndexedDB under
 * a locally minted uuid, that uuid becomes the answer, and the send queue
 * exchanges it for the real one when it finally drains. Everything downstream
 * of the answer sees a uuid either way and does not need to know which.
 */

export type UploadOutcome =
  /** In storage. `id` is the real attachment row. */
  | { state: 'sent'; id: string }
  /** On the phone. `id` is a placeholder the queue will replace. */
  | { state: 'queued'; id: string }
  | { state: 'rejected'; reason: 'too_large' | 'unsupported_type' | 'no_storage'; maxBytes?: number };

interface ReserveResponse {
  id: string;
  uploadUrl: string;
}

/**
 * Asks the server for somewhere to put a file, then puts it there.
 *
 * Returns null on any network failure so the caller can fall back to holding
 * the file locally. A rejection — too large, wrong type — is *not* a network
 * failure and is returned as one: keeping a file the server has already refused
 * would mean retrying it forever.
 */
async function upload(
  file: File,
  formVersionId: string,
  fieldKey: string,
): Promise<UploadOutcome | null> {
  let reservation: Response;
  try {
    reservation = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formVersionId,
        fieldKey,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        filename: file.name,
      }),
    });
  } catch {
    return null;
  }

  if (reservation.status === 413) {
    const body = (await reservation.json().catch(() => null)) as { maxBytes?: number } | null;
    return { state: 'rejected', reason: 'too_large', maxBytes: body?.maxBytes };
  }
  if (reservation.status === 415) return { state: 'rejected', reason: 'unsupported_type' };
  if (reservation.status === 503) return { state: 'rejected', reason: 'no_storage' };
  if (!reservation.ok) return null;

  const reserved = (await reservation.json()) as ReserveResponse;

  try {
    const put = await fetch(reserved.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    if (!put.ok) return null;
  } catch {
    /*
     * The row exists but the bytes did not arrive. Deliberately not cleaned up
     * from here: an unclaimed row with no object is exactly the orphan case the
     * sweeper handles, and a phone that just lost its connection is in no
     * position to make a second request to tidy up.
     */
    return null;
  }

  return { state: 'sent', id: reserved.id };
}

/**
 * Takes a file the worker has just chosen and makes it an answer.
 *
 * Tries to send it immediately, because a worker who does have signal should
 * not have to think about any of this. Falls back to the phone otherwise.
 */
export async function captureAttachment(
  file: File,
  formVersionId: string,
  fieldKey: string,
  /** The question's own limit, so an oversized file is refused here. */
  maxBytes?: number,
): Promise<UploadOutcome> {
  /*
   * Checked before anything is parked, and that is the whole point of it.
   *
   * Nothing bounded the size on the way into IndexedDB — `preparePhoto` shrinks
   * photos and runs for nothing else — so a worker attaching a 12 MB scan
   * offline to a 5 MB question was told it was captured. The 413 arrived when
   * the queue eventually drained, hours later, and the file was deleted with
   * nothing shown; if the question was required, the submission then failed
   * validation and stuck. Both losses invisible to the person who could have
   * simply taken a smaller photograph.
   *
   * Same answer the server would give, given while they are still holding the
   * phone.
   */
  if (maxBytes && file.size > maxBytes) {
    return { state: 'rejected', reason: 'too_large', maxBytes };
  }

  if (navigator.onLine) {
    const outcome = await upload(file, formVersionId, fieldKey);
    if (outcome) return outcome;
  }

  const localId = crypto.randomUUID();
  const stored = await putPending({
    localId,
    blob: file,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    fieldKey,
    formVersionId,
    queuedAt: Date.now(),
  });

  if (!stored) {
    /*
     * No IndexedDB and no network. Reported as a rejection rather than a
     * silent success: pretending the photo was captured, then losing it, is the
     * one outcome a worker cannot recover from because they will have moved on.
     */
    return { state: 'rejected', reason: 'no_storage' };
  }

  return { state: 'queued', id: localId };
}

export interface ResolvedAttachments {
  /**
   * The answers, with every placeholder that could be exchanged replaced.
   *
   * Safe — and necessary — to persist even when `complete` is false. Each id in
   * here names bytes that are already in object storage and a blob that has
   * already been deleted from this phone, so it is the only remaining record
   * that the file exists.
   */
  data: Record<string, unknown>;
  /** False when at least one file still has its bytes on this device. */
  complete: boolean;
  /**
   * Placeholders the server refused outright, whose answers are now empty.
   *
   * The submission goes without them rather than blocking forever, which is
   * right — but it is still a document the worker believed they had captured,
   * so it travels with the result instead of vanishing at this line.
   */
  dropped: string[];
}

/**
 * Swaps placeholders for real attachment ids, just before a submission is sent.
 *
 * Walks every string in the answers — including inside repeating sections —
 * and, for any that names a file still sitting on this phone, uploads it and
 * substitutes the id the server gave back. Nothing here needs to know which
 * questions were attachment questions: a uuid that has bytes parked against it
 * is an attachment by construction, and no other value can collide with one.
 *
 * `complete: false` tells the queue to leave the submission for the next
 * attempt — sending it with a placeholder still in it would store a permanent
 * reference to a photograph that does not exist.
 *
 * But the partially resolved answers come back regardless, and the queue writes
 * them to the entry before it stops. This used to return a bare null, throwing
 * that work away: a household roster whose second photo failed lost the *first*
 * photo's real id, while its blob had already been deleted here on the line
 * above. The next attempt found no pending file for the placeholder, passed it
 * through untouched, and the submission was accepted holding a reference no row
 * would ever have — exactly the case the note above says nothing later could
 * repair.
 */
export async function resolvePendingAttachments(
  data: Record<string, unknown>,
): Promise<ResolvedAttachments> {
  let failed = false;
  const dropped: string[] = [];

  const resolveValue = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) items.push(await resolveValue(item));
      return items;
    }

    if (value && typeof value === 'object') {
      // A repeating section's entry. Recursed into so a household roster with a
      // photo per member does not strand five files.
      const entries = Object.entries(value as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      for (const [key, nested] of entries) out[key] = await resolveValue(nested);
      return out;
    }

    if (typeof value !== 'string') return value;

    const pending = await getPending(value);
    if (!pending) return value;

    const file = new File([pending.blob], pending.filename, { type: pending.mimeType });
    const outcome = await upload(file, pending.formVersionId, pending.fieldKey);

    if (outcome?.state === 'sent') {
      await deletePending(value);
      return outcome.id;
    }

    /*
     * A file the server refused will never be accepted, so the placeholder is
     * dropped and the answer becomes empty rather than blocking the submission
     * forever. Anything else is a network problem and is worth retrying.
     */
    if (outcome?.state === 'rejected') {
      await deletePending(value);
      dropped.push(value);
      return null;
    }

    failed = true;
    return value;
  };

  const resolved = (await resolveValue(data)) as Record<string, unknown>;
  return { data: resolved, complete: !failed, dropped };
}
