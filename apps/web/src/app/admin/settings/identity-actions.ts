'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { updateOrgIdentity } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

export interface IdentityState {
  ok?: boolean;
  error?: string;
}

/**
 * A field that is either filled in or explicitly cleared.
 *
 * An empty input means "I have not told you this", which is `null` in the
 * database — not `''`. The same distinction `pruneBlank` keeps for translatable
 * text, and for the same reason: a stored empty string is indistinguishable
 * from an answer on the way back out, so `missingForNotice` would think the
 * grievance officer had been named.
 */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => (value.trim() === '' ? null : value.trim()))
    .nullable()
    .optional();

const schema = z.object({
  legalName: optionalText(200),
  entityType: optionalText(100),
  registrationNumber: optionalText(100),
  registeredAddress: optionalText(500),
  grievanceOfficerName: optionalText(200),
  /*
   * Validated only when something was typed. `z.string().email()` on an empty
   * field would reject the very common case of an NGO that gives a phone
   * number and no email at all.
   */
  grievanceOfficerEmail: optionalText(200).refine(
    (value) => value == null || z.string().email().safeParse(value).success,
    { message: 'Not an email address' },
  ),
  grievanceOfficerPhone: optionalText(30),
  dpoName: optionalText(200),
  dpoEmail: optionalText(200).refine(
    (value) => value == null || z.string().email().safeParse(value).success,
    { message: 'Not an email address' },
  ),
  // ISO 3166-1 alpha-2. Not a free-text field: it decides where data may be
  // hosted, and "India " with a trailing space must not read as a new region.
  dataRegion: z.enum(['IN', 'ANY']).optional(),
  isSignificantDataFiduciary: z.boolean().optional(),
});

export async function updateOrgIdentityAction(
  patch: z.input<typeof schema>,
): Promise<IdentityState> {
  const parsed = schema.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Those details could not be saved.' };
  }

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => updateOrgIdentity(tx, session.orgId, parsed.data));

  revalidatePath('/admin/settings');
  // The setup checklist counts a named grievance officer as a step.
  revalidatePath('/admin/setup');
  return { ok: true };
}
