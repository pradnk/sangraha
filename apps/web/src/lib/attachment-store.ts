'use client';

/**
 * Photos and files waiting for a connection.
 *
 * The send queue keeps submissions in localStorage, which is right for a few
 * kilobytes of JSON and hopeless for a photograph: the quota is around 5 MB for
 * the whole origin, strings only, so one base64-encoded photo would fill it and
 * take every queued submission down with it. Binary needs IndexedDB.
 *
 * The shape of the problem: a worker photographs someone in a village with no
 * signal. The submission cannot be sent, and neither can the photo — but the
 * answer has to hold *something*, and the form engine requires that something to
 * be a uuid. So a local uuid is minted, the bytes are parked here under it, and
 * the send queue swaps it for the real attachment id at the moment it finally
 * uploads. The placeholder never reaches the server.
 */

const DB_NAME = 'mis.attachments';
const DB_VERSION = 1;
const STORE = 'pending';

export interface PendingAttachment {
  /** The placeholder uuid standing in for this file in the answers. */
  localId: string;
  blob: Blob;
  filename: string;
  mimeType: string;
  fieldKey: string;
  formVersionId: string;
  queuedAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'localId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    /*
     * Private browsing on some phones refuses IndexedDB outright. Resolving
     * null rather than rejecting lets every caller degrade to "upload now or
     * not at all", which is worse than offline capture but far better than a
     * camera button that throws.
     */
    request.onerror = () => resolve(null);
  });
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const request = work(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function putPending(entry: PendingAttachment): Promise<boolean> {
  const result = await run('readwrite', (store) => store.put(entry) as IDBRequest<IDBValidKey>);
  return result !== null;
}

export async function getPending(localId: string): Promise<PendingAttachment | null> {
  const result = await run('readonly', (store) => store.get(localId) as IDBRequest<PendingAttachment>);
  return result ?? null;
}

export async function deletePending(localId: string): Promise<void> {
  await run('readwrite', (store) => store.delete(localId) as IDBRequest<undefined>);
}

export async function listPending(): Promise<PendingAttachment[]> {
  const result = await run('readonly', (store) => store.getAll() as IDBRequest<PendingAttachment[]>);
  return result ?? [];
}

/**
 * Forgets files nothing will ever send.
 *
 * A submission the queue gave up on, or a form abandoned before Save, leaves
 * bytes here that no answer refers to. Without a sweep they accumulate for the
 * life of the device — and unlike a queued submission, a stale photograph is
 * personal data sitting on a phone that may be shared between workers.
 */
export async function prunePending(keepLocalIds: Set<string>, olderThanMs: number): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const all = await listPending();

  let removed = 0;
  for (const entry of all) {
    if (keepLocalIds.has(entry.localId) || entry.queuedAt >= cutoff) continue;
    await deletePending(entry.localId);
    removed += 1;
  }
  return removed;
}
