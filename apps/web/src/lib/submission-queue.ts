'use client';

/**
 * Client-side send queue.
 *
 * Every submission is written to localStorage first and only then sent. A dead
 * zone, a closed tab or a killed browser costs nothing — the entry is still
 * there and drains on the next opportunity.
 *
 * This is the cheap 80% of offline support, and it exists in v1 even though
 * full offline is a later phase. It is also deliberately the same abstraction
 * that phase will extend: swapping localStorage for IndexedDB and adding form
 * caching turns this into real offline sync rather than requiring a rewrite.
 */

import { resolvePendingAttachments } from './attachment-upload';

const QUEUE_KEY = 'mis.submissionQueue';
const STRANDED_KEY = 'mis.strandedConsent';

/**
 * How long to wait after a failed send, doubling each time.
 *
 * The sweep runs every 30 seconds, so without this a submission that keeps
 * failing is retried twice a minute forever. The ceiling matters as much as the
 * base: a worker who walks back into signal after two hours should not wait
 * another hour for their morning's records to go.
 */
const RETRY_BASE_MS = 30_000;
const RETRY_CEILING_MS = 15 * 60_000;

function backoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10), RETRY_CEILING_MS);
}

export interface QueuedSubmission {
  clientUuid: string;
  formVersionId: string;
  subjectId?: string | null;
  locationId?: string | null;
  data: Record<string, unknown>;
  deviceMeta?: Record<string, unknown>;
  /**
   * Consent captured with this record.
   *
   * Travels with the submission because at registration the subject does not
   * exist until the server creates it. Its presence changes how this entry is
   * treated on failure — see `send` and `markFailed`.
   */
  consent?: Record<string, unknown>[];
  queuedAt: number;
  attempts: number;
  lastError?: string;
  /**
   * Earliest time this entry may be tried again.
   *
   * Set on every transient failure. Nothing is ever removed from the queue for
   * failing too often — see `markTransient` for why.
   */
  nextAttemptAt?: number;
  /**
   * Set when the server refused the payload itself.
   *
   * Such an entry is never sent again, because it cannot succeed, but it is
   * kept: it holds a record somebody captured, and the worker is still counted
   * as having something on the device. Deleting it is the one thing that makes
   * the data unrecoverable.
   */
  blockedError?: string;
  /**
   * Which answers clashed, when `blockedError` is a 409.
   *
   * The only refusal a worker can do anything about, so it is kept with the
   * entry rather than only returned to whichever drain happened to receive it.
   */
  blockedIssues?: DuplicateIssue[];
  /** Placeholders whose files the server refused, so the answer went empty. */
  droppedAttachments?: string[];
}

type Listener = (queue: QueuedSubmission[]) => void;
const listeners = new Set<Listener>();

function read(): QueuedSubmission[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedSubmission[]) : [];
  } catch {
    // Corrupt storage must not brick the app. Losing a malformed queue is
    // better than a worker who can never submit again.
    return [];
  }
}

function write(queue: QueuedSubmission[]): void {
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  listeners.forEach((listener) => listener(queue));
}

export function subscribeToQueue(listener: Listener): () => void {
  listeners.add(listener);
  listener(read());
  return () => listeners.delete(listener);
}

export function getQueue(): QueuedSubmission[] {
  return read();
}

/** One question's answer that another record already holds. */
export interface DuplicateIssue {
  fieldKey: string;
  label: string;
  value: string;
}

export type EnqueueResult =
  /** Accepted by the server, or safely waiting to be sent. */
  | { outcome: 'accepted' }
  /**
   * The server refused it: a question marked unique already has this answer.
   *
   * Surfaced rather than left to the queue, because this is the one 4xx a
   * worker can actually fix — and the queue drains in the background, so the
   * screen would otherwise say "Saved" for a record that was refused.
   */
  | { outcome: 'duplicate'; issues: DuplicateIssue[] };

/**
 * Queues a submission and immediately attempts to send it.
 *
 * Waiting for the send is what lets a uniqueness rule be enforced at all: it
 * needs the server, so the answer has to come back before the worker is told
 * their record is saved. Offline, the entry stays queued and is reported as
 * accepted — refusing to save a record because a phone has no signal would
 * lose real data to prevent a hypothetical clash.
 *
 * The drain is asked to take *this* entry first, and the caller waits for a
 * drain already in flight rather than stepping around it. Both of those matter:
 * without them "Saved" could mean no request had been made at all. A sweep
 * running on the same screen would trip the re-entrancy guard, or an earlier
 * entry failing on 2G would break the loop before reaching this one, and either
 * way an empty refusals map came back and was read as acceptance — with the
 * uniqueness check silently skipped and the draft deleted.
 */
export async function enqueueSubmission(
  entry: Omit<QueuedSubmission, 'queuedAt' | 'attempts'>,
): Promise<EnqueueResult> {
  const queue = read();
  // Keyed by clientUuid so a double-tap on Save cannot enqueue twice.
  if (!queue.some((item) => item.clientUuid === entry.clientUuid)) {
    queue.push({ ...entry, queuedAt: Date.now(), attempts: 0 });
    write(queue);
  }

  /*
   * Declared before the drain rather than inferred from which drain answers.
   *
   * Whichever drain performs the send has to know somebody is waiting on this
   * entry, because a sweep that started a moment earlier will happily pick it
   * up — it reads the queue after this function has written to it. Keyed by
   * entry, so the two cannot disagree.
   */
  watching.set(entry.clientUuid, null);
  try {
    await drainQueue(entry.clientUuid);
    const clash = watching.get(entry.clientUuid);
    return clash ? { outcome: 'duplicate', issues: clash } : { outcome: 'accepted' };
  } finally {
    watching.delete(entry.clientUuid);
  }
}

/**
 * Entries somebody is currently on a screen waiting for, and what came back.
 *
 * Only ever holds an entry for the duration of one `enqueueSubmission`. Its
 * presence is what tells `send` that a 409 will be shown to a person, which
 * decides whether the record may be dropped — see the 409 branch there.
 */
const watching = new Map<string, DuplicateIssue[] | null>();

/**
 * The drain currently in flight, so a second caller queues behind it.
 *
 * This used to be a boolean that made an overlapping call return an empty map
 * immediately. That is right for the 30-second sweep, which can simply try
 * again — and wrong for `enqueueSubmission`, which is waiting to find out
 * whether the server refused the record a worker is standing in front of.
 * Serialising rather than skipping means the answer it gets is about its own
 * entry.
 */
let inFlight: Promise<unknown> = Promise.resolve();

/**
 * Attempts to send everything queued.
 *
 * Serial rather than parallel: a worker on a 2G connection is better served by
 * one request completing than by five timing out together.
 *
 * `watched` names the one entry a person is waiting on. It only affects the
 * order — what a refusal *means* is decided by the `watching` map, because the
 * send may well happen in a sweep that started before that caller arrived.
 */
export function drainQueue(watched?: string): Promise<Map<string, DuplicateIssue[]>> {
  const next = inFlight.then(() => runDrain(watched));
  // The chain must survive a failed drain, or every later caller inherits the
  // rejection and the queue stops draining for the life of the page.
  inFlight = next.catch(() => undefined);
  return next;
}

async function runDrain(watched?: string): Promise<Map<string, DuplicateIssue[]>> {
  const refused = new Map<string, DuplicateIssue[]>();
  if (typeof window === 'undefined' || !navigator.onLine) return refused;

  const now = Date.now();
  /*
   * The watched entry goes first, so the `break` below — which is there to stop
   * hammering a dead connection — cannot leave the one request somebody is
   * waiting on unmade.
   */
  const queue = read();
  const ordered = watched
    ? [...queue].sort((a, b) => Number(b.clientUuid === watched) - Number(a.clientUuid === watched))
    : queue;

  for (const entry of ordered) {
    // Refused for good, or still inside its backoff window. Skipped rather
    // than breaking, so one stuck entry cannot hold up everything behind it.
    if (entry.blockedError) continue;
    if ((entry.nextAttemptAt ?? 0) > now) continue;

    const result = await send(entry);
    if (result.duplicate) refused.set(entry.clientUuid, result.duplicate);
    if (!result.done) break; // Network is down; let the retry timer handle it.
  }

  return refused;
}

interface SendOutcome {
  /** Whether the queue may move on to the next entry. */
  done: boolean;
  /** Present when a uniqueness rule refused it. */
  duplicate?: DuplicateIssue[];
}

async function send(entry: QueuedSubmission): Promise<SendOutcome> {
  /*
   * Photos and files first.
   *
   * A submission captured offline holds placeholder ids for its attachments,
   * with the bytes parked in IndexedDB. They have to become real attachment
   * rows before the record referring to them exists — a submission stored with
   * a placeholder would point at a photograph forever absent, and there is
   * nothing later that could repair it.
   *
   * A failure here is a network failure, so the entry stays queued and is not
   * counted as an attempt: the submission is fine, its photo just has not
   * uploaded yet.
   *
   * Whatever *did* upload is written back to the entry first, before anything
   * decides to stop. Those bytes have already left the phone and the blob is
   * already deleted; the real id in the resolved answers is the only thing that
   * still knows where the file went.
   */
  const resolved = await resolvePendingAttachments(entry.data);
  persistData(entry.clientUuid, resolved.data, resolved.dropped);
  if (!resolved.complete) return { done: false };
  const data = resolved.data;

  try {
    const response = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entry, data }),
      /*
       * Not `follow`, which is the default and was quietly destroying records.
       * `requireSession` answers an expired session with a redirect to /login,
       * not a 401 — and a followed redirect returns the login page's 200, which
       * this function read as "accepted" and deleted the submission for. The
       * same applies to `mustChangePin`, which redirects every send to
       * /change-pin.
       */
      redirect: 'manual',
    });

    /*
     * An opaque redirect: status 0, `ok` false, nothing readable. That is what
     * a same-origin 3xx looks like under `redirect: 'manual'`, and it always
     * means the session is no longer usable. Kept queued so it sends the moment
     * the worker signs back in.
     */
    if (response.type === 'opaqueredirect' || response.status === 0) return { done: false };
    if (response.status >= 300 && response.status < 400) return { done: false };

    if (response.ok) {
      remove(entry.clientUuid);
      return { done: true };
    }

    if (response.status === 401 || response.status === 403) {
      // The session lapsed. Leave the entry queued — it will send once the
      // worker signs back in, rather than being silently discarded.
      return { done: false };
    }

    if (response.status === 409) {
      /*
       * A question marked unique already holds this answer. It can never
       * succeed on retry, so what happens next turns entirely on whether
       * anybody is there to be told.
       */
      const body = (await response.json().catch(() => null)) as {
        issues?: DuplicateIssue[];
      } | null;
      const issues = body?.issues ?? [];

      // The record is going back to the worker to fix, but the attestation
      // already happened and must not go with it.
      strandConsent(entry, '409');

      if (watching.has(entry.clientUuid)) {
        watching.set(entry.clientUuid, issues);
        /*
         * The worker is on the save screen. The clash goes straight back to
         * them, `commit` keeps the draft and sends them to the offending
         * question, and saving again queues a corrected record under a new id —
         * so the answers are still on the phone and keeping this entry as well
         * would leave a permanent orphan of the record they just fixed.
         */
        remove(entry.clientUuid);
      } else {
        /*
         * Nobody is watching, and this is where the record used to disappear.
         *
         * `startQueueDraining` sweeps every 30 seconds and discards what the
         * drain returns, so a worker who registered somebody offline, saw
         * "Saved", and walked into signal had the capture deleted from
         * localStorage by a 409 they were never shown — the draft already gone,
         * the counter back to zero, and no error anywhere. Kept as blocked
         * instead, with the clash attached so a screen can explain it.
         */
        markBlocked(entry.clientUuid, '409', issues);
      }

      return { done: true, duplicate: issues };
    }

    if (response.status >= 400 && response.status < 500) {
      /*
       * A 4xx will never succeed on retry: the payload itself is the problem.
       * So the entry stops being retried — but it is *kept*, with the error
       * attached, and the drain steps over it rather than being blocked by it.
       *
       * These still need a visible "needs attention" queue in the UI, tracked
       * for Phase 1. Until then the worker at least sees them in the count and
       * is warned about them at sign-out.
       */
      strandConsent(entry, `${response.status}`);
      markBlocked(entry.clientUuid, `${response.status}`);
      return { done: true };
    }

    markTransient(entry.clientUuid, `${response.status}`);
    return { done: false };
  } catch {
    markTransient(entry.clientUuid, 'network');
    return { done: false };
  }
}

function remove(clientUuid: string): void {
  write(read().filter((item) => item.clientUuid !== clientUuid));
}

/** Saves answers changed in flight — a placeholder exchanged for a real id. */
function persistData(
  clientUuid: string,
  data: Record<string, unknown>,
  dropped: string[] = [],
): void {
  const queue = read();
  const entry = queue.find((item) => item.clientUuid === clientUuid);
  // Nothing moved, or the entry has since been sent by another drain.
  if (!entry) return;
  const unchanged = JSON.stringify(entry.data) === JSON.stringify(data);
  if (unchanged && dropped.length === 0) return;

  write(
    queue.map((item) =>
      item.clientUuid === clientUuid
        ? {
            ...item,
            data,
            // A file the server refused. The record goes without it rather than
            // blocking forever, but the worker believed they had captured it,
            // so it is kept with the entry for the screen that will say so.
            ...(dropped.length
              ? { droppedAttachments: [...(item.droppedAttachments ?? []), ...dropped] }
              : {}),
          }
        : item,
    ),
  );
}

/**
 * A send that failed for a reason that may not last: no signal, a 5xx, a
 * captive portal.
 *
 * Nothing is ever deleted here, and that is the whole point of the function.
 * It used to drop an entry after ten attempts, with no delay between them —
 * and since the sweep runs every 30 seconds and its only guard is
 * `navigator.onLine`, which stays true on a captive portal or an
 * associated-but-dead mobile connection, five minutes of bad signal silently
 * destroyed a morning's records. The queue indicator simply stopped showing a
 * count, which a worker reads as "everything sent".
 *
 * So instead the entry waits longer each time and keeps waiting. A record on a
 * phone can still be sent tomorrow; a record deleted from a phone cannot.
 */
function markTransient(clientUuid: string, error: string): void {
  write(
    read().map((item) => {
      if (item.clientUuid !== clientUuid) return item;
      const attempts = item.attempts + 1;
      return {
        ...item,
        attempts,
        lastError: error,
        nextAttemptAt: Date.now() + backoffMs(attempts),
      };
    }),
  );
}

/**
 * A send the server refused outright. Kept, but never attempted again.
 *
 * `issues` is carried for the one refusal a worker can act on — a clash on a
 * question marked unique — so whatever eventually shows the held-back queue can
 * name the answer rather than only the status code.
 */
function markBlocked(clientUuid: string, error: string, issues?: DuplicateIssue[]): void {
  write(
    read().map((item) =>
      item.clientUuid === clientUuid
        ? {
            ...item,
            attempts: item.attempts + 1,
            lastError: error,
            blockedError: error,
            ...(issues?.length ? { blockedIssues: issues } : {}),
          }
        : item,
    ),
  );
}

/**
 * Parks consent events for the next opportunity to send them.
 *
 * Exported for the refusal screen, which has no submission to attach to and so
 * cannot use the main queue: a refusal ends the capture, and there is nothing
 * to save. Without this its `fetch` was the only attempt, and a worker standing
 * in a village with no signal lost the record that they had asked at all.
 *
 * Requires a `subjectId`, which is what `/api/consent` needs to write the row.
 */
export function queueConsentEvents(events: Record<string, unknown>[]): void {
  const attachable = events.filter((event) => event.subjectId);
  if (attachable.length === 0) return;
  strandEvents(attachable, 'refused_offline');
}

/**
 * Keeps a consent alive when the submission carrying it is abandoned.
 *
 * The queue is allowed to give up on a record: a malformed payload will never
 * save, and retrying it forever blocks everything behind it. Losing the
 * *attestation* is a different matter — somebody stood in front of a worker and
 * agreed, and a statutory record of that cannot be discarded because an
 * unrelated validation rule rejected the answers.
 *
 * So it is moved to its own list and re-sent through `/api/consent`, which has
 * no dependency on the submission. Idempotent on `clientEventUuid`, so a
 * consent that did reach the server on an earlier attempt is simply recognised
 * as a replay.
 */
function strandConsent(entry: QueuedSubmission, reason: string): void {
  if (!entry.consent?.length || !entry.subjectId) return;
  strandEvents(
    entry.consent.map((event) => ({ ...event, subjectId: entry.subjectId })),
    reason,
  );
}

/** Appends to the stranded list, skipping anything already on it. */
function strandEvents(events: Record<string, unknown>[], reason: string): void {
  try {
    const raw = window.localStorage.getItem(STRANDED_KEY);
    const stranded = raw ? (JSON.parse(raw) as Record<string, unknown>[]) : [];

    const known = new Set(stranded.map((event) => event.clientEventUuid));
    const rescued = events
      .filter((event) => !known.has(event.clientEventUuid))
      .map((event) => ({ ...event, strandedReason: reason }));

    if (rescued.length === 0) return;
    window.localStorage.setItem(STRANDED_KEY, JSON.stringify([...stranded, ...rescued]));
  } catch {
    // Storage full or unavailable. Nothing better to do than carry on; the
    // record is already lost and throwing here would lose the rest of the queue
    // with it.
  }
}

/**
 * Re-sends attestations whose submission was abandoned.
 *
 * Runs on the same triggers as the main drain. Kept separate from it so a
 * poisoned submission cannot block a consent behind it — which was the whole
 * problem being solved.
 */
async function drainStrandedConsent(): Promise<void> {
  let stranded: Record<string, unknown>[];
  try {
    const raw = window.localStorage.getItem(STRANDED_KEY);
    stranded = raw ? (JSON.parse(raw) as Record<string, unknown>[]) : [];
  } catch {
    return;
  }
  if (stranded.length === 0) return;

  try {
    const response = await fetch('/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: stranded.map(({ strandedReason: _reason, ...event }) => event),
      }),
    });

    // 409 means the server already has these under the same ids, differently —
    // retrying cannot help, and holding them forever helps nobody either.
    if (response.ok || response.status === 409) {
      window.localStorage.removeItem(STRANDED_KEY);
    }
  } catch {
    // Offline. They stay for the next attempt.
  }
}

/** Wires up retry triggers. Called once from the field layout. */
export function startQueueDraining(): () => void {
  const onOnline = () => {
    void drainQueue();
    void drainStrandedConsent();
  };
  window.addEventListener('online', onOnline);

  // A 30-second sweep catches the common case the `online` event misses:
  // connectivity that is nominally present but was failing a moment ago.
  const timer = window.setInterval(() => {
    void drainQueue();
    void drainStrandedConsent();
  }, 30_000);
  void drainQueue();

  return () => {
    window.removeEventListener('online', onOnline);
    window.clearInterval(timer);
  };
}
