'use server';

import { revalidatePath } from 'next/cache';
import { asc, eq } from 'drizzle-orm';
import { applyTranslations, localise, missingLocales } from '@sangraha/form-engine';
import { formFields, getEditableVersion, getFormBySlug, getOrCreateDraft, organisations } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { getTranslationProvider } from '@/lib/translation';

export interface TranslateState {
  error?: string;
  filled?: number;
  skipped?: string[];
}

/**
 * Fills in missing translations for every question on a form.
 *
 * Deliberately gap-filling. It never touches text a person has written, so an
 * admin can machine-translate the bulk and hand-correct the few that matter
 * without the next run undoing their work. Everything it writes is flagged
 * unreviewed, and the flag clears the moment someone edits that text.
 *
 * Runs against the draft: translating is an edit, and edits do not reach field
 * workers until Publish.
 */
export async function translateFormAction(slug: string): Promise<TranslateState> {
  const provider = getTranslationProvider();
  if (!provider) {
    return {
      error:
        'Automatic translation is not set up on this installation. Add a GOOGLE_TRANSLATE_API_KEY, or type the translations in yourself.',
    };
  }

  const session = await requireRole(['org_admin', 'super_admin']);

  const result = await withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) return { error: 'Form not found.' };

    const [org] = await tx
      .select({ locales: organisations.enabledLocales })
      .from(organisations)
      .where(eq(organisations.id, session.orgId))
      .limit(1);

    const wanted = (org?.locales ?? ['en']).filter((l) => l !== 'en');
    if (wanted.length === 0) {
      return {
        error: 'Turn on another language under Organisation first, then there will be something to translate into.',
      };
    }

    const unsupported = wanted.filter((locale) => !provider.supports(locale));
    const targets = wanted.filter((locale) => provider.supports(locale));
    if (targets.length === 0) {
      return { error: 'None of your languages can be translated automatically yet.' };
    }

    const versionId = await getOrCreateDraft(tx, form.id, session.userId);
    const fields = await tx
      .select()
      .from(formFields)
      .where(eq(formFields.formVersionId, versionId))
      .orderBy(asc(formFields.sortOrder));

    /*
     * Accumulate across languages, then write once per question.
     *
     * The obvious shape — update inside the per-language loop — is wrong: the
     * rows were read once, so translating into Hindi and then Kannada applied
     * the Kannada result to the *original* label and silently dropped the
     * Hindi one. An organisation with two languages got one.
     */
    const working = new Map(
      fields.map((field) => [
        field.id,
        {
          label: { ...field.label },
          labelMachine: { ...(field.labelMachine ?? {}) },
          help: field.help ? { ...field.help } : null,
          helpMachine: { ...(field.helpMachine ?? {}) },
          touched: false,
        },
      ]),
    );

    let filled = 0;

    for (const locale of targets) {
      const pending: { id: string; needsLabel: boolean; needsHelp: boolean }[] = [];
      const texts: string[] = [];

      for (const field of fields) {
        const state = working.get(field.id)!;
        // `localise` rather than `label.en`: a question written only in Hindi
        // still has source text worth translating, and a blank source would
        // otherwise produce a blank translation.
        const labelSource = localise(state.label, 'en');
        const helpSource = localise(state.help, 'en');

        const needsLabel = labelSource !== '' && missingLocales(state.label, [locale]).length > 0;
        const needsHelp =
          helpSource !== '' && !!state.help && missingLocales(state.help, [locale]).length > 0;
        if (!needsLabel && !needsHelp) continue;

        pending.push({ id: field.id, needsLabel, needsHelp });
        if (needsLabel) texts.push(labelSource);
        if (needsHelp) texts.push(helpSource);
      }

      if (pending.length === 0) continue;

      let translated: string[];
      try {
        // One call per language, not per question: providers bill and
        // rate-limit per call.
        translated = await provider.translate(texts, 'en', locale);
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Translation failed.' };
      }

      let cursor = 0;
      for (const entry of pending) {
        const state = working.get(entry.id)!;

        if (entry.needsLabel) {
          const next = applyTranslations(
            { text: state.label, machine: state.labelMachine },
            { [locale]: translated[cursor++] ?? '' },
          );
          state.label = next.text;
          state.labelMachine = next.machine ?? {};
          state.touched = true;
          filled += 1;
        }

        if (entry.needsHelp) {
          const next = applyTranslations(
            { text: state.help ?? {}, machine: state.helpMachine },
            { [locale]: translated[cursor++] ?? '' },
          );
          state.help = next.text;
          state.helpMachine = next.machine ?? {};
          state.touched = true;
          filled += 1;
        }
      }
    }

    for (const [fieldId, state] of working) {
      if (!state.touched) continue;
      await tx
        .update(formFields)
        .set({
          label: state.label,
          labelMachine: state.labelMachine,
          help: state.help,
          helpMachine: state.helpMachine,
        })
        .where(eq(formFields.id, fieldId));
    }

    return { filled, skipped: unsupported };
  });

  revalidatePath(`/admin/forms/${slug}`);
  return result;
}

/** Whether the Translate button should appear at all. */
export async function translationAvailableAction(): Promise<boolean> {
  await requireRole(['org_admin', 'super_admin']);
  return getTranslationProvider() !== null;
}

export async function formNeedsTranslationAction(slug: string): Promise<boolean> {
  const session = await requireRole(['org_admin', 'super_admin']);

  return withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) return false;

    const [org] = await tx
      .select({ locales: organisations.enabledLocales })
      .from(organisations)
      .where(eq(organisations.id, session.orgId))
      .limit(1);

    const wanted = (org?.locales ?? ['en']).filter((l) => l !== 'en');
    if (wanted.length === 0) return false;

    const editable = await getEditableVersion(tx, form.id);
    if (!editable) return false;

    const fields = await tx
      .select({ label: formFields.label })
      .from(formFields)
      .where(eq(formFields.formVersionId, editable.id));

    return fields.some((field) => missingLocales(field.label, wanted).length > 0);
  });
}
