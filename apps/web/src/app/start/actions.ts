'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { WeakPinError, getOwnerDb, provisionOrganisation } from '@sangraha/db';
import { createSession } from '@/lib/auth/session';
import { signupAvailability, signupCodeMatches } from '@/lib/signup';

export interface StartState {
  error?: string;
  field?: 'name' | 'fullName' | 'username' | 'pin' | 'confirmPin' | 'code';
  /**
   * What they typed, sent back so the form can put it there again.
   *
   * React resets an uncontrolled form once its action returns, so without this
   * a rejected PIN also wiped the organisation name, their name and their
   * sign-in name — punishing one small mistake by making them retype
   * everything. **The PINs are deliberately absent**: they never travel back to
   * the browser, and retyping one after a rejection is the right thing to ask
   * for anyway.
   */
  values?: { name: string; fullName: string; username: string; code: string };
}

const schema = z.object({
  name: z.string().min(2, 'Give your organisation a name.').max(200),
  fullName: z.string().min(1, 'Enter your name.').max(120),
  username: z
    .string()
    .min(2, 'Choose a sign-in name of at least two characters.')
    .max(40)
    .regex(/^[a-z0-9_]+$/i, 'Use only letters, numbers and underscores in your sign-in name.'),
  pin: z.string().min(6, 'Your PIN needs at least 6 numbers.').max(12),
  confirmPin: z.string(),
  code: z.string().optional(),
});

/**
 * Creates an organisation and signs its founder in as administrator.
 *
 * Unlike the CLI, the person is present and chooses their own PIN — so there is
 * no temporary credential to pass on and no forced change on first sign-in.
 */
export async function startAction(
  previousOrFormData: StartState | FormData,
  maybeFormData?: FormData,
): Promise<StartState> {
  const formData =
    maybeFormData instanceof FormData
      ? maybeFormData
      : previousOrFormData instanceof FormData
        ? previousOrFormData
        : undefined;
  if (!formData) return { error: 'Something went wrong. Please try again.' };

  /*
   * Re-checked here, not just on the page that rendered the form.
   *
   * The bootstrap exemption is a race by nature: two people could load `/start`
   * on an empty installation at the same time. Whoever posts second finds an
   * organisation already exists and is refused.
   */
  const availability = await signupAvailability();
  if (!availability.allowed) {
    return {
      error:
        'This installation already has an organisation, and new ones are not being accepted. Ask its administrator to add you.',
    };
  }

  const asText = (key: string): string => {
    const value = formData.get(key);
    return typeof value === 'string' ? value : '';
  };

  // Kept for every failure path below, so no rejection costs the typing.
  const values = {
    name: asText('name'),
    fullName: asText('fullName'),
    username: asText('username'),
    code: asText('code'),
  };

  const parsed = schema.safeParse({
    name: formData.get('name'),
    fullName: formData.get('fullName'),
    username: formData.get('username'),
    pin: formData.get('pin'),
    confirmPin: formData.get('confirmPin'),
    code: formData.get('code') ?? undefined,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: issue?.message ?? 'Please check the details.',
      field: issue?.path[0] as never,
      values,
    };
  }

  if (availability.requiresCode && !signupCodeMatches(parsed.data.code)) {
    return { error: 'That invitation code is not right.', field: 'code', values };
  }

  if (parsed.data.pin !== parsed.data.confirmPin) {
    return { error: 'The two PINs are not the same.', field: 'confirmPin', values };
  }

  let result;
  try {
    result = await provisionOrganisation(getOwnerDb(), {
      name: parsed.data.name,
      adminUsername: parsed.data.username,
      adminFullName: parsed.data.fullName,
      adminPin: parsed.data.pin,
      // They chose it themselves, so there is nothing to force them to replace.
      mustChangePin: false,
      // English only to begin with. Adding languages is one of the first steps
      // in the setup guide, once they can see what they are translating.
      locales: ['en'],
    });
  } catch (error) {
    if (error instanceof WeakPinError) {
      /*
       * Nothing was written: the PIN is checked before the transaction opens.
       * This used to leave an organisation behind with no administrator, so the
       * next attempt was refused for a name that "already existed" — their own
       * wreckage from the attempt before.
       */
      return { error: weakPinMessage(error.reason), field: 'pin', values };
    }
    throw error;
  }

  if (!result.ok) {
    return {
      error:
        result.reason === 'slug_taken'
          ? 'An organisation with a very similar name already exists here. Try a more specific name.'
          : 'That organisation name cannot be used. Try one with letters and numbers in it.',
      field: 'name',
      values,
    };
  }

  await createSession({
    orgId: result.orgId,
    userId: result.userId,
    role: 'org_admin',
    username: parsed.data.username.toLowerCase(),
    fullName: parsed.data.fullName,
    locale: 'en',
    orgSlug: result.slug,
    mustChangePin: false,
    tokenVersion: 1,
  });

  redirect('/admin/setup');
}


/** Says what is actually wrong with the PIN, rather than one message for all. */
function weakPinMessage(reason: WeakPinError['reason']): string {
  switch (reason) {
    case 'too_common':
      return 'That PIN is too easy to guess. Avoid 111111, 123456 and the like.';
    case 'not_numeric':
      return 'Your PIN can only contain numbers.';
    case 'too_short':
      return 'Your PIN needs at least 6 numbers.';
    case 'too_long':
      return 'Your PIN can be at most 12 numbers.';
  }
}
