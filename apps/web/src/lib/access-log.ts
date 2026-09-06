import { recordAccess, type AccessEventInput } from '@sangraha/db';
import { withSession } from '@/lib/auth/guard';
import type { SessionPayload } from '@/lib/auth/session';

/**
 * Records that somebody looked at personal data.
 *
 * Written through `withSession` rather than the owner connection, so the RLS
 * insert policy is what confines the row to the caller's own organisation — the
 * same rule as every other write. That costs one extra round trip per logged
 * act, which is the right price: the alternative is an audit log written with
 * privileges the audited request does not have.
 *
 * Never awaited by the caller for correctness. `recordAccess` swallows its own
 * failures, so a logging outage cannot take down the screen it is logging;
 * awaiting it here simply keeps the write inside the request's lifetime, which
 * a serverless function will otherwise cut short.
 */
export async function logAccess(
  session: SessionPayload,
  event: AccessEventInput,
): Promise<void> {
  try {
    await withSession(session, (tx) =>
      recordAccess(
        tx,
        {
          orgId: session.orgId,
          userId: session.userId,
          username: session.username,
          role: session.role,
        },
        event,
      ),
    );
  } catch (error) {
    /*
     * The outer catch, and the one that actually holds.
     *
     * `recordAccess` swallows the insert error, but postgres.js re-raises at
     * the transaction boundary regardless — so without this, a failed audit
     * write would surface as a 500 on the page being logged. The transaction
     * this wraps contains nothing but the log insert, so there is no other
     * work to lose.
     */
    console.error('[access-log] could not write', event.action, error);
  }
}

/**
 * The filters in force, as the URL expressed them.
 *
 * Kept verbatim rather than parsed: it is what actually decided the result set,
 * and re-deriving it later from a changed filter format would be guesswork.
 * Paging is stripped — `page=3` says nothing about which people were exposed,
 * and leaving it in makes two views of the same data look like different scopes.
 */
export function scopeOf(params: URLSearchParams): string | null {
  const scope = new URLSearchParams(params);
  for (const noise of ['page', 'per', 'tech']) scope.delete(noise);
  const text = scope.toString();
  return text === '' ? null : text;
}
