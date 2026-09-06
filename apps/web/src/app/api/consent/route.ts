import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConsentConflictError, recordConsentEvents } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { consentEventSchema } from '@/lib/consent-schema';

/**
 * Recording consent on its own.
 *
 * The submissions endpoint carries consent alongside a registration, because
 * the subject does not exist until that transaction creates it. This one exists
 * for everything with no form behind it: a withdrawal, re-consent when a child
 * turns eighteen, or a purpose added after somebody was already registered.
 *
 * Both call the same writer. Two writers would mean two places that could
 * forget the clock clamp, the lock or the pseudonym.
 *
 * A plain route rather than a server action, for the same reason
 * `/api/submissions` is one: the offline queue has to be able to re-`fetch` it
 * on its own schedule, long after the page that started it has gone.
 */

const bodySchema = z.object({ events: z.array(consentEventSchema).min(1).max(50) });

export async function POST(request: Request) {
  const session = await requireSession();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = await withSession(session, (tx) =>
      recordConsentEvents(
        tx,
        { orgId: session.orgId, userId: session.userId, role: session.role },
        parsed.data.events,
      ),
    );
    return NextResponse.json(result, { status: result.written > 0 ? 201 : 200 });
  } catch (error) {
    if (error instanceof ConsentConflictError) {
      /*
       * The same idempotency key with different content. A client bug or
       * tampering, never a retry — and retrying will not fix it, so the queue
       * must be told to stop rather than left burning attempts.
       */
      return NextResponse.json(
        { error: 'conflicting_replay', clientEventUuid: error.clientEventUuid },
        { status: 409 },
      );
    }
    throw error;
  }
}
