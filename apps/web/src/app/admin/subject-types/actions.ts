'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { pruneBlank } from '@sangraha/form-engine';
import {
  createSubjectType,
  deleteSubjectType,
  updateSubjectType,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

export interface SubjectTypeState {
  error?: string;
  ok?: boolean;
  selectId?: string;
}

const i18nText = z.record(z.string().max(200));

export async function createSubjectTypeAction(name: string): Promise<SubjectTypeState> {
  const parsed = z.string().min(1).max(120).safeParse(name);
  if (!parsed.success) return { error: 'Give it a name — Student, Household, Farmer.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  const result = await withSession(session, (tx) =>
    createSubjectType(tx, session.orgId, { en: parsed.data }),
  );

  if (!result.ok) {
    return {
      error:
        result.reason === 'code_taken'
          ? 'Something with that name already exists.'
          : 'That name cannot be used. Try one with letters in it.',
    };
  }

  revalidatePath('/admin/subject-types');
  return { ok: true, selectId: result.id };
}

/** A pointer to a question by key: set, explicitly cleared, or left alone. */
const nomination = z
  .string()
  .max(120)
  .nullish()
  .transform((v) => (v === undefined ? undefined : v || null));

const patchSchema = z.object({
  id: z.string().uuid(),
  name: i18nText.optional(),
  icon: z.string().max(40).nullish(),
  displayNameFields: z.array(z.string().max(120)).max(6).optional(),
  matchFields: z.array(z.string().max(120)).max(6).optional(),
  /*
   * Three states, not two: set, cleared, and not mentioned.
   *
   * Clearing a nomination is a real edit and an empty string would be a key
   * that matches no question, so `''` and `null` both have to mean "clear it".
   * The `undefined` guard is what keeps *absent* out of that: a transform runs
   * on a missing key too, and returning `null` there put the key in the parsed
   * object with a value the caller never sent.
   *
   * Every edit on this screen sends a narrow patch — `{ id, isActive }` when a
   * toggle flips, `{ id, displayNameFields }` when the list changes — and
   * `updateSubjectType` spreads the whole patch into `.set()`. So renaming a
   * subject type on blur silently cleared its date-of-birth nomination, and
   * with it every child on that type resolved as an adult. That is the exact
   * failure the schema comment on `dateOfBirthField` warns about.
   */
  dateOfBirthField: nomination,
  ageYearsField: nomination,
  contactField: nomination,
  isActive: z.boolean().optional(),
});

export async function updateSubjectTypeAction(
  patch: z.input<typeof patchSchema>,
): Promise<SubjectTypeState> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: 'That change could not be saved.' };

  const { id, name, ...rest } = parsed.data;
  const session = await requireRole(['org_admin', 'super_admin']);

  await withSession(session, (tx) =>
    updateSubjectType(tx, id, { ...rest, ...(name ? { name: pruneBlank(name) } : {}) }),
  );

  revalidatePath('/admin/subject-types');
  revalidatePath('/admin/forms');
  return { ok: true };
}

export async function deleteSubjectTypeAction(id: string): Promise<SubjectTypeState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  const result = await withSession(session, (tx) => deleteSubjectType(tx, session.orgId, id));

  if (!result.ok) return { error: result.reason };

  revalidatePath('/admin/subject-types');
  return { ok: true };
}
