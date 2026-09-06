'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { WeakPinError, changePin, getOwnerDb } from '@sangraha/db';
import { createSession, readSession } from '@/lib/auth/session';
import { m } from '@/lib/messages';

const schema = z.object({
  currentPin: z.string().min(1).max(12),
  newPin: z.string().min(1).max(12),
  confirmPin: z.string().min(1).max(12),
});

export interface ChangePinState {
  error?: string;
}

export async function submitNewPin(
  _previous: ChangePinState,
  formData: FormData,
): Promise<ChangePinState> {
  const session = await readSession();
  if (!session) redirect('/login');

  const locale = session.locale;
  const parsed = schema.safeParse({
    currentPin: formData.get('currentPin'),
    newPin: formData.get('newPin'),
    confirmPin: formData.get('confirmPin'),
  });
  if (!parsed.success) return { error: m(locale, 'pinTooShort') };

  if (parsed.data.newPin !== parsed.data.confirmPin) {
    return { error: m(locale, 'pinsDoNotMatch') };
  }

  try {
    const result = await changePin(
      getOwnerDb(),
      session.userId,
      parsed.data.currentPin,
      parsed.data.newPin,
    );
    if (!result.ok) {
      // Told apart, because the two need different things from the worker:
      // one is "try again", the other is "wait or call your supervisor".
      return result.reason === 'locked'
        ? {
            error: m(locale, 'accountLocked', {
              minutes: Math.max(1, Math.ceil(result.retryAfterSeconds / 60)),
            }),
          }
        : { error: m(locale, 'wrongPin') };
    }
  } catch (error) {
    if (error instanceof WeakPinError) {
      // Translated per reason rather than surfacing the raw error, which reads
      // as a system fault rather than as something to do differently.
      return {
        error:
          error.reason === 'too_common'
            ? m(locale, 'pinTooCommon')
            : m(locale, 'pinTooShort'),
      };
    }
    throw error;
  }

  // changePin bumps tokenVersion, invalidating the current cookie, so the
  // session has to be reissued or the worker is bounced to login immediately.
  await createSession({
    ...session,
    mustChangePin: false,
    tokenVersion: session.tokenVersion + 1,
  });

  redirect('/');
}
