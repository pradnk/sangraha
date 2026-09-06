'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getOwnerDb, login, recordAccess } from '@sangraha/db';
import { createSession } from '@/lib/auth/session';
import { m } from '@/lib/messages';

const schema = z.object({
  orgSlug: z.string().min(1).max(80),
  username: z.string().min(1).max(80),
  pin: z.string().min(1).max(12),
  locale: z.string().min(2).max(5).default('en'),
});

export interface LoginState {
  error?: string;
  /** Names the field at fault so the form can point at it. */
  field?: 'orgSlug' | 'username' | 'pin';
}

/**
 * Signs a user in.
 *
 * Accepts both server-action call shapes. React's `useActionState` invokes it
 * as `(previousState, formData)`, but the same action reached directly — a
 * progressive-enhancement POST, or a client that does not send the bound state
 * — arrives as `(formData)`. Reading the wrong argument crashes with an
 * unhelpful 500, so the FormData is identified rather than assumed by position.
 */
export async function signIn(
  previousOrFormData: LoginState | FormData,
  maybeFormData?: FormData,
): Promise<LoginState> {
  const formData =
    maybeFormData instanceof FormData
      ? maybeFormData
      : previousOrFormData instanceof FormData
        ? previousOrFormData
        : undefined;

  if (!formData) return { error: m('en', 'wrongPin') };

  const locale = String(formData.get('locale') ?? 'en');

  const parsed = schema.safeParse({
    orgSlug: formData.get('orgSlug'),
    username: formData.get('username'),
    pin: formData.get('pin'),
    locale,
  });

  if (!parsed.success) {
    // Point at the field that is actually missing. Reporting a blank
    // organisation as "that name or PIN is not right" sends the user to check
    // credentials that were never the problem.
    const missing = parsed.error.issues[0]?.path[0];
    if (missing === 'orgSlug') return { error: m(locale, 'chooseOrganisation'), field: 'orgSlug' };
    if (missing === 'username') return { error: m(locale, 'enterName'), field: 'username' };
    if (missing === 'pin') return { error: m(locale, 'enterPin'), field: 'pin' };
    return { error: m(locale, 'wrongPin') };
  }

  const result = await login(getOwnerDb(), parsed.data);

  if (!result.ok) {
    switch (result.reason) {
      case 'locked':
        return {
          error: m(locale, 'accountLocked', {
            minutes: Math.max(1, Math.ceil(result.retryAfterSeconds / 60)),
          }),
        };
      case 'inactive':
        return { error: m(locale, 'accountInactive') };
      default:
        // One message for a wrong name and a wrong PIN — saying which was wrong
        // would also tell an attacker which usernames exist.
        return { error: m(locale, 'wrongPin'), field: 'pin' };
    }
  }

  /*
   * A successful sign-in, on the owner connection because no session context
   * exists yet — this is the moment one is being created. Failures are
   * deliberately not logged here: they are already counted against the account
   * by `login()`'s lockout, and writing a row per attempt would let anyone
   * with a username flood an organisation's audit log.
   */
  await recordAccess(
    getOwnerDb(),
    {
      orgId: result.user.orgId,
      userId: result.user.userId,
      username: result.user.username,
      role: result.user.role,
    },
    { action: 'sign_in', targetType: 'organisation', targetId: result.user.orgId },
  );

  await createSession({
    orgId: result.user.orgId,
    userId: result.user.userId,
    role: result.user.role,
    username: result.user.username,
    fullName: result.user.fullName,
    /*
     * The user's saved preference wins; the login-screen choice is the fallback.
     *
     * The switcher on the login screen is there so the *login screen* is
     * readable on a shared phone — it is remembered per device. But once
     * someone has set a language in their account, that is their setting and it
     * has to survive signing out, or it reads as broken. Anyone who ends up in
     * a language they cannot read can change it from Your account.
     */
    locale: result.user.locale || parsed.data.locale,
    orgSlug: result.user.orgSlug,
    mustChangePin: result.user.mustChangePin,
    tokenVersion: result.user.tokenVersion,
  });

  redirect(result.user.mustChangePin ? '/change-pin' : '/');
}
