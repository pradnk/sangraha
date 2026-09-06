'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createForm, getFormBySlug, toSnakeCase } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

const schema = z
  .object({
    name: z.string().min(1, 'Give the form a name.').max(120),
    formType: z.enum(['registration', 'encounter', 'standalone']),
    subjectTypeId: z.string().uuid().nullish(),
  })
  /*
   * A registration form with nothing to register, or a visit attached to
   * nobody, is the gap that left the whole registry inert: forms built through
   * this screen had no subject type, so submitting one created no person and
   * `submissions.subject_id` stayed null forever.
   */
  .refine((value) => value.formType === 'standalone' || Boolean(value.subjectTypeId), {
    message: 'Choose who this form is about.',
    path: ['subjectTypeId'],
  });

export interface NewFormState {
  error?: string;
}

export async function createFormAction(
  previousOrFormData: NewFormState | FormData,
  maybeFormData?: FormData,
): Promise<NewFormState> {
  const formData =
    maybeFormData instanceof FormData
      ? maybeFormData
      : previousOrFormData instanceof FormData
        ? previousOrFormData
        : undefined;
  if (!formData) return { error: 'Something went wrong. Please try again.' };

  const session = await requireRole(['org_admin', 'super_admin']);

  const parsed = schema.safeParse({
    name: formData.get('name'),
    formType: formData.get('formType'),
    subjectTypeId: formData.get('subjectTypeId') || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  }

  /*
   * The slug is derived, never typed.
   *
   * It names the analytics view and the API path and is permanent, so letting
   * an admin type it invites both a typo they cannot undo and a name they will
   * later want to change. Renaming the form afterwards is free; the slug stays.
   */
  const slug = await withSession(session, async (tx) => {
    const base = toSnakeCase(parsed.data.name).slice(0, 50) || 'form';
    let candidate = base;
    let suffix = 2;
    while (await getFormBySlug(tx, session.orgId, candidate)) {
      candidate = `${base}_${suffix++}`;
    }

    await createForm(tx, session.orgId, {
      slug: candidate,
      name: { en: parsed.data.name },
      formType: parsed.data.formType,
      // Standalone forms are about nobody in particular, so this stays null.
      subjectTypeId: parsed.data.formType === 'standalone' ? null : parsed.data.subjectTypeId,
    });
    return candidate;
  });

  redirect(`/admin/forms/${slug}`);
}
