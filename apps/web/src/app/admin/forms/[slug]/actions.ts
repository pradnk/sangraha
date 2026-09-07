'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  addField,
  backfillSubjectsForForm,
  checkDelete,
  checkTypeChange,
  countAnswersForKey,
  deleteField,
  discardDraft,
  getFormBySlug,
  getOrCreateDraft,
  publishDraft,
  regenerateFormViews,
  reorderFields,
  resolveFieldInVersion,
  setFormAudience,
  setFormSubjectType,
  updateField,
  getOwnerDb,
  formFields,
  PLACEHOLDER_LABEL,
} from '@sangraha/db';
import { eq } from 'drizzle-orm';
import { markReviewed, ruleNodeSchema } from '@sangraha/form-engine';
import { requireRole, withSession } from '@/lib/auth/guard';

export interface BuilderState {
  error?: string;
  warning?: string;
  ok?: boolean;
  /** Field id to select after the page refreshes. */
  selectId?: string;
}

const i18nText = z.record(z.string());

/** Resolves the form and its open draft, creating the draft on first edit. */
async function withDraft<T>(
  slug: string,
  work: (ctx: { formId: string; versionId: string; tx: Parameters<Parameters<typeof withSession>[1]>[0] }) => Promise<T>,
): Promise<T> {
  const session = await requireRole(['org_admin', 'super_admin']);
  return withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) throw new Error('Form not found');
    const versionId = await getOrCreateDraft(tx, form.id, session.userId);
    return work({ formId: form.id, versionId, tx });
  });
}

export async function addFieldAction(
  slug: string,
  dataType: string,
  /** Set by a palette preset, e.g. an email question is text with a format. */
  config?: Record<string, unknown>,
): Promise<BuilderState> {
  const parsed = z.string().min(1).safeParse(dataType);
  if (!parsed.success) return { error: 'Unknown question type.' };

  const presetConfig = z.record(z.unknown()).optional().safeParse(config);
  if (!presetConfig.success) return { error: 'That question could not be added.' };

  const id = await withDraft(slug, ({ versionId, tx }) =>
    addField(tx, versionId, {
      config: presetConfig.data,
      /*
       * A new question starts with a placeholder rather than an empty label,
       * so the preview has something to render immediately. The key derived
       * from it is provisional: `updateField` re-derives it the moment a real
       * label is typed, so the analytics column ends up called `guardian_phone`
       * rather than `untitled_question_2`.
       */
      label: { en: PLACEHOLDER_LABEL },
      dataType: parsed.data as never,
    }),
  );

  revalidatePath(`/admin/forms/${slug}`);
  return { ok: true, selectId: id };
}

const patchSchema = z.object({
  fieldId: z.string().uuid(),
  label: i18nText.optional(),
  help: i18nText.nullish(),
  isRequired: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  optionSetId: z.string().uuid().nullish(),
  config: z.record(z.unknown()).optional(),
  visibilityRule: ruleNodeSchema.nullish(),
  isArchived: z.boolean().optional(),
  dataType: z.string().optional(),
  /** Why this question is collected. Null clears it back to unattributed. */
  purposeId: z.string().uuid().nullish(),
  dataDescription: i18nText.nullish(),
  /** Set when the edit came from a person typing, so the draft flag clears. */
  reviewedLocale: z.string().min(2).max(5).optional(),
});

export async function updateFieldAction(
  slug: string,
  patch: z.input<typeof patchSchema>,
): Promise<BuilderState> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: 'That change could not be saved.' };
  const { fieldId: requestedId, dataType, reviewedLocale, ...rest } = parsed.data;

  const result = await withDraft(slug, async ({ formId, versionId, tx }) => {
    /*
     * The id the browser sent can belong to the published version — that is
     * what the builder renders when there is no draft — and `withDraft` has
     * just copied every field into a new draft under new ids. Editing the id
     * as sent would rewrite the published version instead.
     */
    const fieldId = await resolveFieldInVersion(tx, versionId, requestedId);
    if (!fieldId) return { error: 'That question no longer exists.' };

    // A type change is the one edit that can destroy meaning, so it is checked
    // against the answers already collected before anything is written.
    if (dataType) {
      const [current] = await tx
        .select({ key: formFields.key, dataType: formFields.dataType })
        .from(formFields)
        .where(eq(formFields.id, fieldId))
        .limit(1);

      if (current && current.dataType !== dataType) {
        const answers = await countAnswersForKey(tx, formId, current.key);
        const verdict = checkTypeChange(current.dataType, dataType as never, answers);
        if (!verdict.allowed) return { error: verdict.reason };
        await updateField(tx, versionId, fieldId, { ...rest, dataType: dataType as never });
        return { ok: true, warning: verdict.warning };
      }
    }

    /*
     * A person typing over a machine translation makes it reviewed.
     *
     * Without this the draft warning would never clear, and a corrected
     * translation would be silently re-translated on the next run.
     */
    if (reviewedLocale) {
      const [current] = await tx
        .select({ labelMachine: formFields.labelMachine, helpMachine: formFields.helpMachine })
        .from(formFields)
        .where(eq(formFields.id, fieldId))
        .limit(1);

      if (current) {
        if (rest.label) {
          (rest as Record<string, unknown>).labelMachine = markReviewed(
            { text: {}, machine: current.labelMachine ?? {} },
            reviewedLocale,
          );
        }
        if (rest.help !== undefined) {
          (rest as Record<string, unknown>).helpMachine = markReviewed(
            { text: {}, machine: current.helpMachine ?? {} },
            reviewedLocale,
          );
        }
      }
    }

    await updateField(tx, versionId, fieldId, rest as never);
    return { ok: true };
  });

  revalidatePath(`/admin/forms/${slug}`);
  return result;
}

/**
 * Deletes a question, or refuses and explains why.
 *
 * Refusing is the common case on a live form. The message offers archiving,
 * which is what the admin almost always actually wants: stop asking the
 * question, keep the answers.
 */
export async function deleteFieldAction(
  slug: string,
  requestedId: string,
): Promise<BuilderState> {
  const result = await withDraft(slug, async ({ formId, versionId, tx }) => {
    const fieldId = await resolveFieldInVersion(tx, versionId, requestedId);
    if (!fieldId) return { error: 'That question no longer exists.' };

    const [field] = await tx
      .select({ key: formFields.key })
      .from(formFields)
      .where(eq(formFields.id, fieldId))
      .limit(1);
    if (!field) return { error: 'That question no longer exists.' };

    const answers = await countAnswersForKey(tx, formId, field.key);
    const verdict = checkDelete(answers);
    if (!verdict.allowed) return { error: verdict.reason };

    await deleteField(tx, versionId, fieldId);
    return { ok: true };
  });

  revalidatePath(`/admin/forms/${slug}`);
  return result;
}

export async function archiveFieldAction(
  slug: string,
  requestedId: string,
  isArchived: boolean,
): Promise<BuilderState> {
  const result = await withDraft(slug, async ({ versionId, tx }) => {
    const fieldId = await resolveFieldInVersion(tx, versionId, requestedId);
    if (!fieldId) return { error: 'That question no longer exists.' };
    await updateField(tx, versionId, fieldId, { isArchived });
    return { ok: true };
  });

  revalidatePath(`/admin/forms/${slug}`);
  return result;
}

export async function reorderFieldsAction(
  slug: string,
  orderedIds: string[],
): Promise<BuilderState> {
  const parsed = z.array(z.string().uuid()).safeParse(orderedIds);
  if (!parsed.success) return { error: 'That change could not be saved.' };

  await withDraft(slug, async ({ versionId, tx }) => {
    /*
     * Same stale-id problem as every other edit, and it used to fail the other
     * way: `reorderFields` was already scoped to the version, so a published
     * id simply matched nothing and the drag silently did not stick.
     */
    const resolved: string[] = [];
    for (const id of parsed.data) {
      const fieldId = await resolveFieldInVersion(tx, versionId, id);
      if (fieldId) resolved.push(fieldId);
    }
    await reorderFields(tx, versionId, resolved);
  });

  revalidatePath(`/admin/forms/${slug}`);
  return { ok: true };
}

/**
 * Publishes the draft and rebuilds the analytics views.
 *
 * The publish itself runs as the admin, under RLS. The view regeneration is
 * DDL and runs on the owner connection — the request-serving role has no such
 * rights, which is what stops "an admin pressed Publish" from ever becoming
 * arbitrary schema change.
 */
export async function publishAction(slug: string): Promise<BuilderState> {
  const session = await requireRole(['org_admin', 'super_admin']);

  const result = await withSession<
    { formId: string; warnings: string[] } | { error: string }
  >(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) return { error: 'Form not found.' };
    const published = await publishDraft(tx, form.id, session.userId);
    return published.ok
      ? { formId: form.id, warnings: published.warnings }
      : { error: published.problems.map((p) => p.message).join(' ') };
  });

  if ('error' in result) return { error: result.error };

  // DDL, so it runs on the owner connection after the version is committed.
  await regenerateFormViews(getOwnerDb(), result.formId);

  revalidatePath(`/admin/forms/${slug}`);
  revalidatePath('/admin/forms');
  revalidatePath('/');

  /*
   * Published, but with something the admin needs to know: a uniqueness rule
   * cannot reach backwards over data already collected. Reported as a warning
   * rather than swallowed, so nobody believes a guarantee the data does not
   * meet.
   */
  return result.warnings.length > 0
    ? { ok: true, warning: result.warnings.join(' ') }
    : { ok: true };
}

export async function discardDraftAction(slug: string): Promise<BuilderState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (form) await discardDraft(tx, form.id);
  });

  revalidatePath(`/admin/forms/${slug}`);
  return { ok: true };
}


/**
 * Points the form at the kind of subject it is about.
 *
 * Separate from the rest of the builder because it belongs to the *form*, not
 * to a draft version: it changes who future submissions register, immediately,
 * without needing a publish.
 */
export async function setSubjectTypeAction(
  slug: string,
  subjectTypeId: string | null,
): Promise<{ error?: string }> {
  const session = await requireRole(['org_admin', 'super_admin']);

  const parsed = z.string().uuid().nullable().safeParse(subjectTypeId);
  if (!parsed.success) return { error: 'That is not a valid choice.' };

  const result = await withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) return { ok: false as const, reason: 'That form could not be found.' };
    return setFormSubjectType(tx, session.orgId, form.id, parsed.data);
  });

  if (!result.ok) return { error: result.reason };

  revalidatePath(`/admin/forms/${slug}`);
  revalidatePath('/admin/forms');
  return {};
}

/**
 * Sets who may use the form.
 *
 * A form setting, not a draft one — the same reasoning as `setSubjectTypeAction`
 * above. An admin narrowing a form because the wrong team has been filling it in
 * wants that true now, not after they remember to press Publish.
 *
 * The ids are validated for shape here and re-resolved against the organisation
 * inside `setFormAudience`. Shape is all this layer can honestly check; whether
 * a uuid names one of *your* people is a question only the database can answer.
 */
export async function setFormAudienceAction(
  slug: string,
  audience: string,
  userIds: string[],
): Promise<{ error?: string }> {
  const session = await requireRole(['org_admin', 'super_admin']);

  const parsed = z
    .object({
      audience: z.enum(['everyone', 'supervisors', 'admins']),
      userIds: z.array(z.string().uuid()).max(500),
    })
    .safeParse({ audience, userIds });

  if (!parsed.success) return { error: 'That is not a valid choice.' };

  const result = await withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) return { ok: false as const, reason: 'That form could not be found.' };
    return setFormAudience(tx, {
      formId: form.id,
      orgId: session.orgId,
      audience: parsed.data.audience,
      userIds: parsed.data.userIds,
    });
  });

  if (!result.ok) return { error: 'That form could not be found.' };

  revalidatePath(`/admin/forms/${slug}`);
  revalidatePath('/admin/forms');
  // The worker's home screen is built from the same predicate, and so is the
  // review queue — narrowing a form changes which records a supervisor may
  // approve, not only which forms they may fill in.
  revalidatePath('/');
  revalidatePath('/review');
  return {};
}

/**
 * Registers the people behind records that were captured before this form had
 * a subject type.
 *
 * The data is real — a field worker collected it — so the repair is to catch
 * the records up, never to ask anyone to key them in again.
 */
export async function backfillSubjectsAction(
  slug: string,
): Promise<{ error?: string; registered?: number }> {
  const session = await requireRole(['org_admin', 'super_admin']);

  const result = await withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) return { error: 'That form could not be found.' };

    if (form.formType !== 'registration') {
      return { error: 'Only a form that registers people can do this.' };
    }
    if (!form.subjectTypeId) {
      return { error: 'Choose who this form registers first.' };
    }

    const { registered } = await backfillSubjectsForForm(tx, {
      orgId: session.orgId,
      formId: form.id,
      subjectTypeId: form.subjectTypeId,
      createdBy: session.userId,
    });

    return { registered };
  });

  if (result.error) return result;

  revalidatePath(`/admin/forms/${slug}`);
  revalidatePath('/find');
  return result;
}
