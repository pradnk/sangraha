'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getOwnerDb, users } from '@sangraha/db';
import { createSession, destroySession, readSession } from '@/lib/auth/session';
import { UI_LOCALES } from '@/lib/i18n';

/**
 * Signs out.
 *
 * Only the cookie is cleared. Anything still in the device's send queue stays in
 * localStorage and drains once someone signs in again — a worker on a shared
 * phone handing it over must not silently destroy records that have not reached
 * the server yet.
 */
export async function signOutAction(): Promise<void> {
  const session = await readSession();
  await destroySession();
  // Back to their own organisation's login, so the next person does not have to
  // pick it again.
  redirect(session ? `/login?org=${encodeURIComponent(session.orgSlug)}` : '/login');
}

/**
 * Changes the interface language.
 *
 * Written to `users.locale` as well as the session cookie. The cookie alone
 * lasted only until sign-out, which made the setting look like it had silently
 * failed — a language preference that does not survive a sign-in is not a
 * preference.
 *
 * Runs on the owner connection: the users policy allows an org-wide read, and
 * this is a self-service write of one column on the caller's own row.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  const session = await readSession();
  if (!session) redirect('/login');

  const parsed = z.enum(UI_LOCALES).safeParse(locale);
  if (!parsed.success) return;

  await getOwnerDb()
    .update(users)
    .set({ locale: parsed.data, updatedAt: new Date() })
    .where(eq(users.id, session.userId));

  await createSession({ ...session, locale: parsed.data });
  redirect('/account');
}
