/**
 * The three ways the send queue used to destroy a worker's morning.
 *
 * Everything here is about the same failure shape and it is the worst one in
 * the product: a record disappears from the phone without ever reaching the
 * server, and the only signal is a counter that quietly stops showing a number
 * — which reads as "everything sent". A submission that is merely stuck can be
 * sent tomorrow. A submission that has been deleted cannot be sent at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Enough of localStorage for the queue, which only ever reads and writes one key. */
function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

let storage: ReturnType<typeof makeStorage>;
let uploadOutcome: { data: Record<string, unknown>; complete: boolean };

/*
 * Stubbed because the real one talks to IndexedDB and to object storage. What
 * is under test is what the queue does with its answer — in particular whether
 * it keeps the ids of files that did upload when a later one did not.
 */
vi.mock('../attachment-upload', () => ({
  resolvePendingAttachments: vi.fn(async () => uploadOutcome),
}));

const entry = (clientUuid: string, data: Record<string, unknown> = { name: 'Asha' }) => ({
  clientUuid,
  formVersionId: '11111111-1111-4111-8111-111111111111',
  data,
});

/** A fresh module per test: the queue holds a `draining` flag across calls. */
async function loadQueue() {
  vi.resetModules();
  return import('../submission-queue');
}

beforeEach(() => {
  storage = makeStorage();
  uploadOutcome = { data: { name: 'Asha' }, complete: true };

  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a session that lapsed while records were queued', () => {
  it('keeps the submission when the send is redirected to the login page', async () => {
    /*
     * The defect: `/api/submissions` starts with `requireSession()`, which
     * calls `redirect('/login')` — a 307, never a 401. `fetch` followed it, the
     * login page answered 200, and `response.ok` deleted the record as sent.
     * The 401 branch written to prevent exactly this could never run.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { redirect?: string }) =>
        init.redirect === 'manual'
          ? { ok: false, status: 0, type: 'opaqueredirect' }
          : // What a followed redirect actually returns: the login page, 200.
            { ok: true, status: 200, type: 'basic' },
      ),
    );

    const { enqueueSubmission, getQueue } = await loadQueue();
    await enqueueSubmission(entry('aaaaaaaa-1111-4111-8111-111111111111'));

    expect(getQueue()).toHaveLength(1);
  });

  it('asks for the redirect rather than following it', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      type: 'basic',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueSubmission } = await loadQueue();
    await enqueueSubmission(entry('aaaaaaaa-2222-4111-8111-111111111111'));

    // Without this the 200 above could just as well be the login page.
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('still removes a submission the server actually accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, type: 'basic' })));

    const { enqueueSubmission, getQueue } = await loadQueue();
    await enqueueSubmission(entry('aaaaaaaa-3333-4111-8111-111111111111'));

    expect(getQueue()).toHaveLength(0);
  });
});

describe('a connection that is nominally up but going nowhere', () => {
  it('never deletes a submission for failing too often', async () => {
    /*
     * The defect: ten attempts with no delay, a sweep every 30 seconds, and
     * `navigator.onLine` — which stays true on a captive portal — as the only
     * guard. Five minutes of bad signal permanently deleted the queue.
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueSubmission, drainQueue, getQueue } = await loadQueue();
    await enqueueSubmission(entry('bbbbbbbb-1111-4111-8111-111111111111'));

    for (let sweep = 0; sweep < 40; sweep += 1) {
      // An hour on, so every sweep is past the previous backoff and each one is
      // a real attempt rather than a skip.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await drainQueue();
    }

    expect(fetchMock).toHaveBeenCalledTimes(41);
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0]!.attempts).toBe(41);
    expect(getQueue()[0]!.lastError).toBe('network');
    vi.useRealTimers();
  });

  it('waits longer after each failure instead of retrying twice a minute', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueSubmission, drainQueue, getQueue } = await loadQueue();
    await enqueueSubmission(entry('bbbbbbbb-2222-4111-8111-111111111111'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The 30-second sweep, several times over, inside the backoff window.
    await drainQueue();
    await drainQueue();
    await drainQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [queued] = getQueue();
    expect(queued!.attempts).toBe(1);
    expect(queued!.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it('keeps a payload the server refused, and stops retrying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 422, type: 'basic', json: async () => null })),
    );

    const { enqueueSubmission, drainQueue, getQueue } = await loadQueue();
    await enqueueSubmission(entry('bbbbbbbb-3333-4111-8111-111111111111'));

    await drainQueue();
    await drainQueue();

    // Kept — it is a record somebody captured — but never attempted again, so
    // it cannot block anything queued behind it either.
    const [queued] = getQueue();
    expect(queued).toBeDefined();
    expect(queued!.blockedError).toBe('422');
    expect(queued!.attempts).toBe(1);
  });

  it('lets later submissions through while an earlier one is stuck', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { clientUuid: string };
      return sent.clientUuid.startsWith('cccccccc-1111')
        ? { ok: false, status: 422, type: 'basic', json: async () => null }
        : { ok: true, status: 201, type: 'basic' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueSubmission, drainQueue, getQueue } = await loadQueue();
    await enqueueSubmission(entry('cccccccc-1111-4111-8111-111111111111'));
    await enqueueSubmission(entry('cccccccc-2222-4111-8111-111111111111'));
    await drainQueue();

    expect(getQueue().map((item) => item.clientUuid)).toEqual([
      'cccccccc-1111-4111-8111-111111111111',
    ]);
  });
});

describe('a record the server refuses as a duplicate', () => {
  const clash = {
    ok: false,
    status: 409,
    type: 'basic',
    json: async () => ({
      issues: [{ fieldKey: 'phone', label: 'Phone number', value: '9000000001' }],
    }),
  };

  it('keeps the record when the refusal arrives with nobody watching', async () => {
    /*
     * The defect, and the worst one in the file. `startQueueDraining` sweeps
     * every 30 seconds and throws away what the drain returns — so a worker who
     * registered somebody offline, saw "Saved", and walked into signal had the
     * capture deleted from localStorage by a 409 nobody ever showed them. The
     * route answers 409 before inserting, so it was not saved server-side
     * either: the record simply stopped existing.
     */
    vi.stubGlobal('fetch', vi.fn(async () => clash));

    const { enqueueSubmission, drainQueue, getQueue } = await loadQueue();
    // Queued while offline, so the save screen never saw an answer.
    vi.stubGlobal('navigator', { onLine: false });
    await enqueueSubmission(entry('ffffffff-1111-4111-8111-111111111111'));

    // Back in signal. This is the background sweep, not the worker.
    vi.stubGlobal('navigator', { onLine: true });
    await drainQueue();

    const [held] = getQueue();
    expect(held).toBeDefined();
    expect(held!.blockedError).toBe('409');
    // With the clash attached, so a screen can name the answer rather than a
    // status code.
    expect(held!.blockedIssues).toEqual([
      { fieldKey: 'phone', label: 'Phone number', value: '9000000001' },
    ]);
  });

  it('stops retrying it, so it cannot block what is queued behind', async () => {
    const fetchMock = vi.fn(async () => clash);
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueSubmission, drainQueue } = await loadQueue();
    vi.stubGlobal('navigator', { onLine: false });
    await enqueueSubmission(entry('ffffffff-2222-4111-8111-111111111111'));
    vi.stubGlobal('navigator', { onLine: true });

    await drainQueue();
    await drainQueue();
    await drainQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still discards it when the worker is on the save screen', async () => {
    /*
     * The other half, and why this cannot simply always be kept: `commit` holds
     * the draft and sends the worker back to the offending question, and saving
     * again queues a corrected record under a new id. The answers are on the
     * phone either way, so keeping this entry too would leave a permanent
     * orphan of the record they just fixed.
     */
    vi.stubGlobal('fetch', vi.fn(async () => clash));

    const { enqueueSubmission, getQueue } = await loadQueue();
    const result = await enqueueSubmission(entry('ffffffff-3333-4111-8111-111111111111'));

    expect(result).toEqual({
      outcome: 'duplicate',
      issues: [{ fieldKey: 'phone', label: 'Phone number', value: '9000000001' }],
    });
    expect(getQueue()).toHaveLength(0);
  });
});

describe('what "Saved" is allowed to mean', () => {
  it('does not report acceptance when a sweep is already running', async () => {
    /*
     * `QueueIndicator` runs its 30-second sweep on the very page the worker is
     * capturing on. The re-entrancy guard used to make an overlapping
     * `enqueueSubmission` return an empty refusals map immediately, which was
     * read as acceptance — so "Saved" could mean no request had been made, the
     * draft was deleted, and the uniqueness check that waiting for the send
     * exists to perform never ran.
     */
    let release: (() => void) | undefined;
    const firstSent = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        calls += 1;
        const sent = JSON.parse(init.body) as { clientUuid: string };
        if (sent.clientUuid.startsWith('11111111')) {
          await firstSent; // Still in flight while the worker taps Save.
          return { ok: true, status: 201, type: 'basic' };
        }
        return {
          ok: false,
          status: 409,
          type: 'basic',
          json: async () => ({
            issues: [{ fieldKey: 'phone', label: 'Phone number', value: '9' }],
          }),
        };
      }),
    );

    const { enqueueSubmission, drainQueue } = await loadQueue();

    // An earlier record, queued offline, now draining slowly over 2G.
    vi.stubGlobal('navigator', { onLine: false });
    await enqueueSubmission(entry('11111111-1111-4111-8111-111111111111'));
    vi.stubGlobal('navigator', { onLine: true });
    const sweep = drainQueue();

    // The worker saves while that is still in the air.
    const saving = enqueueSubmission(entry('22222222-2222-4111-8111-111111111111'));
    release!();
    await sweep;

    // The clash is reported, not swallowed. Two requests were made, not one.
    expect(await saving).toMatchObject({ outcome: 'duplicate' });
    expect(calls).toBe(2);
  });

  it('sends the record being saved even when an earlier one is failing', async () => {
    /*
     * The other way an empty map came back without the entry being tried: the
     * `break` that stops the drain hammering a dead connection also skipped
     * everything queued behind the failure — including the record the worker
     * was waiting on. It is now attempted first.
     */
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { clientUuid: string };
      if (sent.clientUuid.startsWith('33333333')) throw new Error('offline');
      return {
        ok: false,
        status: 409,
        type: 'basic',
        json: async () => ({
          issues: [{ fieldKey: 'phone', label: 'Phone number', value: '9' }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueSubmission } = await loadQueue();

    // A stuck earlier entry, queued while offline so it is never answered.
    vi.stubGlobal('navigator', { onLine: false });
    await enqueueSubmission(entry('33333333-3333-4111-8111-111111111111'));
    vi.stubGlobal('navigator', { onLine: true });

    const result = await enqueueSubmission(entry('44444444-4444-4111-8111-111111111111'));

    expect(result).toMatchObject({ outcome: 'duplicate' });
  });

  it('still reports acceptance when there is genuinely no signal', async () => {
    // Offline is the case the queue exists for, and refusing to save a record
    // because a phone has no bars would lose real data to prevent a
    // hypothetical clash.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, type: 'basic' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: false });

    const { enqueueSubmission, getQueue } = await loadQueue();
    const result = await enqueueSubmission(entry('55555555-5555-4111-8111-111111111111'));

    expect(result).toEqual({ outcome: 'accepted' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getQueue()).toHaveLength(1);
  });
});

describe('a consent refusal with no submission behind it', () => {
  const STRANDED_KEY = 'mis.strandedConsent';
  const refusal = (subjectId: string | null) => ({
    clientEventUuid: 'eeeeeeee-1111-4111-8111-111111111111',
    subjectId,
    purposeId: '22222222-2222-4222-8222-222222222222',
    action: 'refused',
    lawfulBasis: 'consent',
  });

  it('parks the refusal when there is no signal to send it on', async () => {
    /*
     * A refusal ends the capture, so there is no submission for the main queue
     * to carry it with — its one `fetch` was the only attempt ever made, and a
     * worker in a village with no bars lost the record that the organisation
     * had asked at all. "We asked and they declined" and "we never asked" are
     * different facts and only one of them is a failure.
     */
    const { queueConsentEvents } = await loadQueue();

    queueConsentEvents([refusal('33333333-3333-4333-8333-333333333333')]);

    const stranded = JSON.parse(storage.getItem(STRANDED_KEY) ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({ action: 'refused' });
  });

  it('does not park one with nobody to attach it to', async () => {
    // A registration refused before anybody was created has nothing to point
    // at, and inventing a subject to record that they declined to become one
    // would be the opposite of honouring the refusal.
    const { queueConsentEvents } = await loadQueue();

    queueConsentEvents([refusal(null)]);

    expect(storage.getItem(STRANDED_KEY)).toBeNull();
  });

  it('does not park the same refusal twice', async () => {
    // The screen can re-run its effect, and the server is idempotent on
    // `clientEventUuid` anyway — but a list that grows on every render would
    // eventually fill the origin's storage and take the send queue with it.
    const { queueConsentEvents } = await loadQueue();
    const event = refusal('33333333-3333-4333-8333-333333333333');

    queueConsentEvents([event]);
    queueConsentEvents([event]);

    expect(JSON.parse(storage.getItem(STRANDED_KEY) ?? '[]')).toHaveLength(1);
  });
});

describe('a submission whose photos upload one at a time', () => {
  it('keeps the id of a file that uploaded when a later one failed', async () => {
    /*
     * The defect: `resolvePendingAttachments` deletes each blob from IndexedDB
     * as it uploads, then returned a bare null if a *later* file failed. The
     * real id of the first file was discarded and its bytes were already gone,
     * so the next attempt found nothing pending, passed the placeholder through
     * untouched, and the submission was stored pointing at a photograph that
     * would never exist.
     */
    uploadOutcome = {
      data: { front: 'real-attachment-id', back: 'local-placeholder' },
      complete: false,
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, type: 'basic' })));

    const { enqueueSubmission, getQueue } = await loadQueue();
    await enqueueSubmission(
      entry('dddddddd-1111-4111-8111-111111111111', {
        front: 'local-front',
        back: 'local-placeholder',
      }),
    );

    const [queued] = getQueue();
    expect(queued).toBeDefined();
    expect(queued!.data).toEqual({ front: 'real-attachment-id', back: 'local-placeholder' });
  });

  it('does not send a submission that still holds a placeholder', async () => {
    uploadOutcome = { data: { photo: 'local-placeholder' }, complete: false };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, type: 'basic' }));
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueSubmission, getQueue } = await loadQueue();
    await enqueueSubmission(
      entry('dddddddd-2222-4111-8111-111111111111', { photo: 'local-placeholder' }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getQueue()).toHaveLength(1);
  });
});
