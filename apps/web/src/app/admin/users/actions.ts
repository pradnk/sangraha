'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  createUser,
  generateTemporaryPin,
  resetPin,
  setUserActive,
  setUserLocations,
  unlockUser,
  updateUser,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

export interface UsersState {
  error?: string;
  ok?: boolean;
  /**
   * A newly issued PIN, shown once so the administrator can pass it on.
   * Never stored in readable form and never shown again.
   */
  issuedPin?: { username: string; pin: string };
}

const ROLES = ['field_worker', 'supervisor', 'org_admin'] as const;

export async function createUserAction(
  previousOrFormData: UsersState | FormData,
  maybeFormData?: FormData,
): Promise<UsersState> {
  const formData =
    maybeFormData instanceof FormData
      ? maybeFormData
      : previousOrFormData instanceof FormData
        ? previousOrFormData
        : undefined;
  if (!formData) return { error: 'Something went wrong. Please try again.' };

  const session = await requireRole(['org_admin', 'super_admin']);

  const parsed = z
    .object({
      username: z
        .string()
        .min(2, 'A sign-in name needs at least two characters.')
        .max(40)
        // Field workers type this on a phone keypad-adjacent keyboard, so no
        // spaces, accents or punctuation to get wrong.
        .regex(/^[a-z0-9_]+$/i, 'Use only letters, numbers and underscores.'),
      fullName: z.string().min(1, 'Enter the person’s name.').max(120),
      role: z.enum(ROLES),
      locationIds: z.array(z.string().uuid()).default([]),
    })
    .safeParse({
      username: formData.get('username'),
      fullName: formData.get('fullName'),
      role: formData.get('role'),
      locationIds: formData.getAll('locationIds').filter(Boolean),
    });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the details.' };
  }

  const pin = generateTemporaryPin();

  const result = await withSession(session, (tx) =>
    createUser(tx, session.orgId, { ...parsed.data, temporaryPin: pin }),
  );

  if (!result.ok) {
    return { error: `Someone in your organisation already signs in as “${parsed.data.username}”.` };
  }

  revalidatePath('/admin/users');
  return { ok: true, issuedPin: { username: parsed.data.username, pin } };
}

export async function updateUserAction(
  userId: string,
  patch: { fullName?: string; role?: string },
): Promise<UsersState> {
  const parsed = z
    .object({
      userId: z.string().uuid(),
      fullName: z.string().min(1).max(120).optional(),
      role: z.enum(ROLES).optional(),
    })
    .safeParse({ userId, ...patch });
  if (!parsed.success) return { error: 'That change could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);

  // Removing your own administrator rights would lock you out of the only
  // screen that can restore them.
  if (parsed.data.userId === session.userId && parsed.data.role && parsed.data.role !== 'org_admin') {
    return { error: 'You cannot remove your own administrator access. Ask another administrator.' };
  }

  await withSession(session, (tx) =>
    updateUser(tx, parsed.data.userId, {
      fullName: parsed.data.fullName,
      role: parsed.data.role,
    }),
  );

  revalidatePath('/admin/users');
  return { ok: true };
}

export async function setUserLocationsAction(
  userId: string,
  locationIds: string[],
): Promise<UsersState> {
  const parsed = z
    .object({ userId: z.string().uuid(), locationIds: z.array(z.string().uuid()) })
    .safeParse({ userId, locationIds });
  if (!parsed.success) return { error: 'That change could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) =>
    setUserLocations(tx, parsed.data.userId, parsed.data.locationIds),
  );

  revalidatePath('/admin/users');
  return { ok: true };
}

export async function setUserActiveAction(
  userId: string,
  isActive: boolean,
): Promise<UsersState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  if (userId === session.userId && !isActive) {
    return { error: 'You cannot switch off your own account.' };
  }

  await withSession(session, (tx) => setUserActive(tx, userId, isActive));

  revalidatePath('/admin/users');
  return { ok: true };
}

/**
 * Issues a new temporary PIN.
 *
 * Returned once, in the response, for the administrator to read out. It is
 * stored only as an argon2 hash, so there is no way to retrieve it afterwards —
 * a forgotten PIN is reset, never looked up.
 */
export async function resetPinAction(userId: string, username: string): Promise<UsersState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  const pin = generateTemporaryPin();

  // resetPin bumps token_version, so every device that user is signed in on is
  // signed out — the right behaviour when a PIN is being reset because a phone
  // changed hands.
  await withSession(session, (tx) => resetPin(tx, userId, pin));

  revalidatePath('/admin/users');
  return { ok: true, issuedPin: { username, pin } };
}

export async function unlockUserAction(userId: string): Promise<UsersState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => unlockUser(tx, userId));

  revalidatePath('/admin/users');
  return { ok: true };
}
