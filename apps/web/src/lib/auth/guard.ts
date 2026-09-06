import 'server-only';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getOwnerDb, users, withContext, type RequestContext, type Transaction } from '@sangraha/db';
import { readSession, type SessionPayload } from './session';

/**
 * Loads the signed-in user, or sends them to the login screen.
 *
 * Also enforces `tokenVersion`. Sessions are stateless, so this single lookup
 * is what makes "reset this worker's PIN" or "deactivate this user" take effect
 * immediately instead of whenever the token happens to expire.
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await readSession();
  if (!session) redirect('/login');

  /*
   * Only the user is looked up, deliberately.
   *
   * A session names an organisation too, and checking it here would be dead
   * weight: `users.org_id` is `ON DELETE CASCADE`, and `deleteOrganisation`
   * deletes the row rather than flagging it, so an organisation going away takes
   * its users with it and the `!current` branch below already catches it. This
   * runs on every request, so an extra join to prove something the foreign key
   * guarantees is a cost with no return.
   */
  const [current] = await getOwnerDb()
    .select({ tokenVersion: users.tokenVersion, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!current || !current.isActive || current.tokenVersion !== session.tokenVersion) {
    redirect('/login?reason=expired');
  }

  // A worker with a supervisor-issued PIN can go exactly one place.
  if (session.mustChangePin) redirect('/change-pin');

  return session;
}

export async function requireRole(
  allowed: RequestContext['role'][],
): Promise<SessionPayload> {
  const session = await requireSession();
  if (!allowed.includes(session.role)) redirect('/');
  return session;
}

/**
 * Runs a query as the signed-in user, with their RLS context applied.
 *
 * Every read and write that serves a request should go through this. Anything
 * that does not simply sees nothing, because no policy matches an unset context.
 */
export async function withSession<T>(
  session: SessionPayload,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withContext<T>(
    { orgId: session.orgId, userId: session.userId, role: session.role },
    work,
  );
}
