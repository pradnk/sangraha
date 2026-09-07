import { and, asc, count, desc, eq, isNull, max, ne, sql } from 'drizzle-orm';
import type { FieldDataType, I18nText, RuleNode } from '@sangraha/form-engine';
import {
  getFieldType,
  localise,
  renameRuleDependency,
  ruleDependencies,
  toSnakeCase,
} from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { formAccess, formFields, formVersions, forms, subjectTypes } from '../schema/config';
import { subjects, submissions } from '../schema/data';
import { users } from '../schema/tenancy';
import { countExistingDuplicates } from './submissions';

/**
 * The form builder's data layer.
 *
 * Editing works on a *draft version*. Published versions are immutable, so
 * "edit this form" means find-or-create a draft, change its fields freely, then
 * publish — which freezes it and starts the next draft on the following edit.
 * The admin never sees any of this; they see a form they are editing and a
 * Publish button.
 */

export interface AdminFormSummary {
  id: string;
  slug: string;
  name: I18nText;
  formType: 'registration' | 'encounter' | 'standalone';
  isActive: boolean;
  publishedVersion: number | null;
  hasDraft: boolean;
  submissionCount: number;
  /**
   * True when the form is about a person but has never said which kind.
   *
   * Such a form collects answers and registers nobody — silently, until now.
   * Surfaced in the list so it is visible without opening every form.
   */
  missingSubjectType: boolean;
  /** Who may use it, so the setting is visible without opening every form. */
  audience: 'everyone' | 'supervisors' | 'admins';
  /** How many people are named, when the audience is `named`. */
  namedCount: number;
}

/**
 * The admin forms list.
 *
 * Uses joined aggregates rather than correlated subqueries, deliberately.
 *
 * Drizzle renders an interpolated `${forms.id}` as the bare identifier `"id"`,
 * not `"forms"."id"`. Inside a subquery over a table that also has an `id`
 * column, that resolves to the *inner* table and the correlation silently
 * evaluates to nothing — every form reported "Not published" and "0 responses"
 * while the underlying data was fine. Wrong answers with no error. Aggregating
 * over an explicit join removes the whole hazard.
 *
 * Submissions are counted separately because joining both versions and
 * submissions in one query multiplies the rows and inflates the count.
 */
export async function listFormsForAdmin(db: DbLike, orgId: string): Promise<AdminFormSummary[]> {
  const rows = await db
    .select({
      id: forms.id,
      slug: forms.slug,
      name: forms.name,
      formType: forms.formType,
      isActive: forms.isActive,
      publishedVersion: sql<
        number | null
      >`max(case when ${formVersions.status} = 'published' then ${formVersions.versionNumber} end)`,
      hasDraft: sql<boolean>`coalesce(bool_or(${formVersions.status} = 'draft'), false)`,
      subjectTypeId: forms.subjectTypeId,
    })
    .from(forms)
    .leftJoin(formVersions, eq(formVersions.formId, forms.id))
    .where(eq(forms.orgId, orgId))
    .groupBy(
      forms.id,
      forms.slug,
      forms.name,
      forms.formType,
      forms.isActive,
      forms.subjectTypeId,
      forms.audience,
    )
    .orderBy(asc(forms.slug));

  const counts = await db
    .select({ formId: submissions.formId, total: count() })
    .from(submissions)
    .innerJoin(forms, eq(forms.id, submissions.formId))
    .where(and(eq(forms.orgId, orgId), isNull(submissions.deletedAt)))
    .groupBy(submissions.formId);

  const countByForm = new Map(counts.map((row) => [row.formId, Number(row.total)]));

  // A third query rather than a join, for the reason the count above is
  // separate: joining a second one-to-many would multiply the rows and inflate
  // whichever total was counted second.
  const named = await db
    .select({ formId: formAccess.formId, total: count() })
    .from(formAccess)
    .innerJoin(forms, eq(forms.id, formAccess.formId))
    .where(eq(forms.orgId, orgId))
    .groupBy(formAccess.formId);

  const namedByForm = new Map(named.map((row) => [row.formId, Number(row.total)]));

  return rows.map(({ subjectTypeId, ...row }) => ({
    ...row,
    publishedVersion: row.publishedVersion === null ? null : Number(row.publishedVersion),
    submissionCount: countByForm.get(row.id) ?? 0,
    namedCount: namedByForm.get(row.id) ?? 0,
    missingSubjectType: row.formType !== 'standalone' && !subjectTypeId,
  })) as AdminFormSummary[];
}

export async function getFormBySlug(db: DbLike, orgId: string, slug: string) {
  const [form] = await db
    .select()
    .from(forms)
    .where(and(eq(forms.orgId, orgId), eq(forms.slug, slug)))
    .limit(1);
  return form ?? null;
}

export interface EditableVersion {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published' | 'archived';
}

/**
 * The version the builder should show: the open draft if there is one,
 * otherwise the published version.
 *
 * Read-only, and deliberately does not create anything — merely opening a form
 * to look at it must not leave "unpublished changes" hanging over it.
 */
export async function getEditableVersion(
  db: DbLike,
  formId: string,
): Promise<EditableVersion | null> {
  const [draft] = await db
    .select({ id: formVersions.id, versionNumber: formVersions.versionNumber, status: formVersions.status })
    .from(formVersions)
    .where(and(eq(formVersions.formId, formId), eq(formVersions.status, 'draft')))
    .limit(1);
  if (draft) return draft as EditableVersion;

  const [published] = await db
    .select({ id: formVersions.id, versionNumber: formVersions.versionNumber, status: formVersions.status })
    .from(formVersions)
    .where(and(eq(formVersions.formId, formId), eq(formVersions.status, 'published')))
    .orderBy(desc(formVersions.versionNumber))
    .limit(1);

  return (published as EditableVersion | undefined) ?? null;
}

/**
 * Returns the form's open draft, creating one from the current published
 * version if there is none.
 *
 * Copying rather than starting blank is the point: editing a live form should
 * begin from what is live, not from nothing.
 */
export async function getOrCreateDraft(
  db: DbLike,
  formId: string,
  userId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: formVersions.id })
    .from(formVersions)
    .where(and(eq(formVersions.formId, formId), eq(formVersions.status, 'draft')))
    .limit(1);
  if (existing) return existing.id;

  const [latest] = await db
    .select({ id: formVersions.id, versionNumber: formVersions.versionNumber })
    .from(formVersions)
    .where(eq(formVersions.formId, formId))
    .orderBy(desc(formVersions.versionNumber))
    .limit(1);

  const [draft] = await db
    .insert(formVersions)
    .values({
      formId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      status: 'draft',
      createdBy: userId,
    })
    .returning({ id: formVersions.id });

  if (latest) await copyFields(db, latest.id, draft!.id);

  return draft!.id;
}

/**
 * Copies a version's fields into a new draft.
 *
 * Two passes, because a repeat group's children point at the group's row id and
 * that id changes on copy. Membership is re-resolved by key.
 */
async function copyFields(db: DbLike, fromVersionId: string, toVersionId: string): Promise<void> {
  const source = await db
    .select()
    .from(formFields)
    .where(eq(formFields.formVersionId, fromVersionId))
    .orderBy(asc(formFields.sortOrder));

  const oldIdToKey = new Map(source.map((f) => [f.id, f.key]));
  const newIdByKey = new Map<string, string>();

  for (const field of source.filter((f) => !f.parentGroupId)) {
    const [created] = await db
      .insert(formFields)
      .values({ ...field, id: undefined, formVersionId: toVersionId, parentGroupId: null })
      .returning({ id: formFields.id });
    newIdByKey.set(field.key, created!.id);
  }

  for (const field of source.filter((f) => f.parentGroupId)) {
    const parentKey = oldIdToKey.get(field.parentGroupId!);
    await db.insert(formFields).values({
      ...field,
      id: undefined,
      formVersionId: toVersionId,
      parentGroupId: parentKey ? (newIdByKey.get(parentKey) ?? null) : null,
    });
  }
}

/** Discards an open draft, reverting to whatever is published. */
export async function discardDraft(db: DbLike, formId: string): Promise<void> {
  await db
    .delete(formVersions)
    .where(and(eq(formVersions.formId, formId), eq(formVersions.status, 'draft')));
}

// ---------------------------------------------------------------------------
// Field editing
// ---------------------------------------------------------------------------

/**
 * The label a question is born with, before the admin types a real one.
 *
 * Exported so `isProvisionalKey` and the builder agree on what "not named yet"
 * looks like — two definitions of that would drift.
 */
export const PLACEHOLDER_LABEL = 'Untitled question';

/**
 * True when a key was derived from the placeholder rather than a real label.
 *
 * `untitled_question`, `untitled_question_2`, and so on. These are the keys
 * nobody chose: the builder creates a question with a placeholder label so the
 * preview has something to render, and the key was derived from *that*.
 */
export function isProvisionalKey(key: string): boolean {
  return /^untitled_question(_\d+)?$/.test(key);
}

/**
 * Derives a stable key from the admin's label.
 *
 * The admin never sees or types this, but it is what names the analytics
 * column, the CSV header and the API property, so it has to be readable.
 */
export async function generateFieldKey(
  db: DbLike,
  versionId: string,
  label: string,
  /** The field's own current key, so renaming it does not collide with itself. */
  excludeKey?: string,
): Promise<string> {
  const base = toSnakeCase(label).slice(0, 50) || 'question';
  const taken = new Set(
    (
      await db
        .select({ key: formFields.key })
        .from(formFields)
        .where(eq(formFields.formVersionId, versionId))
    )
      .map((f) => f.key)
      .filter((key) => key !== excludeKey),
  );

  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

export interface NewFieldInput {
  label: I18nText;
  dataType: FieldDataType;
  isRequired?: boolean;
  optionSetId?: string | null;
  parentGroupId?: string | null;
  config?: Record<string, unknown>;
}

export async function addField(
  db: DbLike,
  versionId: string,
  input: NewFieldInput,
): Promise<string> {
  const [last] = await db
    .select({ maxOrder: max(formFields.sortOrder) })
    .from(formFields)
    .where(eq(formFields.formVersionId, versionId));

  const key = await generateFieldKey(db, versionId, localise(input.label, 'en'));

  const [created] = await db
    .insert(formFields)
    .values({
      formVersionId: versionId,
      key,
      label: input.label,
      dataType: input.dataType,
      isRequired: input.isRequired ?? false,
      sortOrder: (last?.maxOrder ?? -1) + 1,
      parentGroupId: input.parentGroupId ?? null,
      optionSetId: input.optionSetId ?? null,
      config: input.config ?? {},
    })
    .returning({ id: formFields.id });

  return created!.id;
}

/**
 * The same question, as it exists in `versionId`.
 *
 * The builder renders whatever `getEditableVersion` returned, and on a form
 * with no open draft that is the *published* version. The first edit then
 * creates a draft — `copyFields` inserts every field again under new row ids —
 * while the browser is still holding the ids it was rendered with. Applying the
 * edit to those ids writes to the published version: a question people have
 * already answered silently changes its label, breaking the promise that a
 * published version is immutable, and the draft the admin believes they are
 * editing never moves.
 *
 * `copyFields` preserves `key`, and a key is unique within a version, so the
 * key is what carries identity across the copy. Returns null when the question
 * is not in this version under any id — a stale tab, not something to write.
 */
export async function resolveFieldInVersion(
  db: DbLike,
  versionId: string,
  fieldId: string,
): Promise<string | null> {
  const [field] = await db
    .select({
      id: formFields.id,
      key: formFields.key,
      versionId: formFields.formVersionId,
      formId: formVersions.formId,
    })
    .from(formFields)
    .innerJoin(formVersions, eq(formVersions.id, formFields.formVersionId))
    .where(eq(formFields.id, fieldId))
    .limit(1);
  if (!field) return null;
  if (field.versionId === versionId) return field.id;

  // Only ever across versions of the same form. An id belonging to another
  // form — or another organisation — resolves to nothing rather than to
  // whatever happens to share its key.
  const [target] = await db
    .select({ id: formFields.id })
    .from(formFields)
    .innerJoin(formVersions, eq(formVersions.id, formFields.formVersionId))
    .where(
      and(
        eq(formFields.formVersionId, versionId),
        eq(formFields.key, field.key),
        eq(formVersions.formId, field.formId),
      ),
    )
    .limit(1);

  return target?.id ?? null;
}

export interface FieldPatch {
  label?: I18nText;
  isUnique?: boolean;
  help?: I18nText | null;
  isRequired?: boolean;
  optionSetId?: string | null;
  config?: Record<string, unknown>;
  visibilityRule?: RuleNode | null;
  isArchived?: boolean;
  dataType?: FieldDataType;
  /** Which purpose this question is collected for. Null clears it. */
  purposeId?: string | null;
  /** The answer described as data, for the privacy notice. */
  dataDescription?: I18nText | null;
}

/**
 * Updates a field on a draft.
 *
 * Scoped to `versionId`, like `reorderFields` — an id that is not in this
 * version is not this version's question to change, and the published version
 * must never be written to by an edit at all. Callers hand the id through
 * `resolveFieldInVersion` first; this is the guard that makes forgetting it
 * a no-op rather than a corrupted published form.
 *
 * The key is normally untouchable — renaming a question must not move its
 * analytics column, and `form_fields.key` names API properties and CSV headers
 * that other people's spreadsheets depend on.
 *
 * There is one exception, and it fixes a real defect. The builder creates every
 * question with the placeholder label "Untitled question", derives the key from
 * it, and freezes it — so a question the admin then names "Guardian's phone"
 * kept the key `untitled_question_2`, and *that* is what appeared as the column
 * heading in every export. Nobody chose it and nobody could change it.
 *
 * So a **provisional** key — one derived from the placeholder, on a question
 * that no answer has ever been recorded against — is re-derived the first time
 * a real label is set. Both conditions matter: the first means the admin never
 * deliberately settled on it, the second means nothing can break.
 */
export async function updateField(
  db: DbLike,
  versionId: string,
  fieldId: string,
  patch: FieldPatch,
): Promise<void> {
  const inVersion = and(eq(formFields.id, fieldId), eq(formFields.formVersionId, versionId));
  const label = patch.label ? localise(patch.label, 'en').trim() : '';

  if (label && label !== PLACEHOLDER_LABEL) {
    const [field] = await db
      .select({
        key: formFields.key,
        formId: formVersions.formId,
      })
      .from(formFields)
      .innerJoin(formVersions, eq(formVersions.id, formFields.formVersionId))
      .where(inVersion)
      .limit(1);

    if (field && isProvisionalKey(field.key)) {
      // Any answer at all — in any version of this form — and the key stays.
      const answers = await countAnswersForKey(db, field.formId, field.key);
      if (answers === 0) {
        const key = await generateFieldKey(db, versionId, label, field.key);
        await db.update(formFields).set({ ...patch, key }).where(inVersion);
        /*
         * Rules point at their dependency by key, and nothing followed the
         * rename. A question whose visibility depended on this one simply
         * stopped matching — `evaluateRule` saw `undefined`, `visibleFields`
         * dropped it from the form *and* from validation, and a required
         * question vanished for every field worker with nothing to show it had.
         *
         * Done in the same call as the rename rather than swept later, because
         * between the two writes the draft is a form nobody could publish
         * correctly.
         */
        await renameRuleDependencies(db, versionId, field.key, key);
        return;
      }
    }
  }

  await db.update(formFields).set(patch).where(inVersion);
}

/** Deletes a field from a draft. Scoped to the version for the same reason. */
/** Repoints every visibility rule in a version from one field key to another. */
async function renameRuleDependencies(
  db: DbLike,
  versionId: string,
  from: string,
  to: string,
): Promise<void> {
  const siblings = await db
    .select({ id: formFields.id, visibilityRule: formFields.visibilityRule })
    .from(formFields)
    .where(eq(formFields.formVersionId, versionId));

  for (const sibling of siblings) {
    const rule = sibling.visibilityRule as RuleNode | null;
    if (!rule) continue;
    if (!ruleDependencies(rule).has(from)) continue;

    await db
      .update(formFields)
      .set({ visibilityRule: renameRuleDependency(rule, from, to) })
      .where(eq(formFields.id, sibling.id));
  }
}

export async function deleteField(
  db: DbLike,
  versionId: string,
  fieldId: string,
): Promise<void> {
  await db
    .delete(formFields)
    .where(and(eq(formFields.id, fieldId), eq(formFields.formVersionId, versionId)));
}

export async function reorderFields(
  db: DbLike,
  versionId: string,
  orderedIds: string[],
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await db
      .update(formFields)
      .set({ sortOrder: index })
      .where(and(eq(formFields.id, id), eq(formFields.formVersionId, versionId)));
  }
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/**
 * How many submissions already hold an answer for this key.
 *
 * Top level *or* inside a repeating section. `data ? key` only ever looked at
 * the top level, and a repeat group's answers are nested — `data[groupKey]` is
 * an array of objects, each with the child keys inside it. So a question inside
 * a repeating section always counted zero, and `checkDelete` and
 * `checkTypeChange` would clear or narrow one that already held answers, which
 * is exactly what they exist to refuse.
 *
 * The nested arm walks one level of arrays of objects, which is as deep as the
 * form engine allows a group to go.
 */
export async function countAnswersForKey(
  db: DbLike,
  formId: string,
  key: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(submissions)
    .where(
      and(
        eq(submissions.formId, formId),
        sql`(
          ${submissions.data} ? ${key}
          OR EXISTS (
            SELECT 1
            FROM jsonb_each(${submissions.data}) AS top(k, v)
            WHERE jsonb_typeof(v) = 'array'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(v) AS entry
                WHERE jsonb_typeof(entry) = 'object' AND entry ? ${key}
              )
          )
        )`,
        ne(submissions.status, 'draft'),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Which type changes are safe once answers exist.
 *
 * Widening keeps every stored value readable; narrowing does not — turning free
 * text into a number leaves the non-numeric answers unreadable in analytics.
 * Anything not listed here is blocked while the field holds data.
 */
const SAFE_WIDENINGS: Partial<Record<FieldDataType, FieldDataType[]>> = {
  integer: ['number', 'short_text', 'long_text'],
  number: ['short_text', 'long_text'],
  short_text: ['long_text'],
  single_choice: ['multi_choice', 'short_text', 'long_text'],
  rating: ['integer', 'number', 'short_text'],
  date: ['short_text'],
  time: ['short_text'],
  boolean: ['short_text'],
  phone: ['short_text', 'long_text'],
};

export type EditVerdict =
  | { allowed: true; warning?: string }
  | { allowed: false; reason: string };

/**
 * Whether a type change may proceed.
 *
 * Phrased for the person reading it, not for a developer: the message is shown
 * verbatim in the builder.
 */
export function checkTypeChange(
  from: FieldDataType,
  to: FieldDataType,
  answerCount: number,
): EditVerdict {
  if (from === to) return { allowed: true };
  if (answerCount === 0) return { allowed: true };

  if (getFieldType(to).isContainer || getFieldType(from).isContainer) {
    return {
      allowed: false,
      reason: `This question already has ${answerCount} answers. A repeating section cannot be changed into another kind of question, or the other way round. Add a new question instead.`,
    };
  }

  if (SAFE_WIDENINGS[from]?.includes(to)) {
    return {
      allowed: true,
      warning: `${answerCount} answers have already been collected. They will be kept and will still work with the new type.`,
    };
  }

  return {
    allowed: false,
    reason: `This question already has ${answerCount} answers, and changing its type would make them unreadable in your reports. Add a new question instead, and archive this one.`,
  };
}

/** Whether a field may be deleted outright, or should be archived instead. */
export function checkDelete(answerCount: number): EditVerdict {
  if (answerCount === 0) return { allowed: true };
  return {
    allowed: false,
    reason: `${answerCount} answers have already been collected for this question. Deleting it would hide them from your reports. Archive it instead — it will stop appearing for field workers, and the answers already collected stay in your data.`,
  };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface PublishProblem {
  fieldKey?: string;
  message: string;
}

/** Checks a draft is fit to go out to field workers. */
export async function validateDraft(db: DbLike, versionId: string): Promise<PublishProblem[]> {
  const fields = await db
    .select()
    .from(formFields)
    .where(eq(formFields.formVersionId, versionId))
    .orderBy(asc(formFields.sortOrder));

  const problems: PublishProblem[] = [];

  if (fields.filter((f) => !f.isArchived).length === 0) {
    problems.push({ message: 'This form has no questions yet. Add at least one before publishing.' });
  }

  /*
   * A registration form with no subject type registers nobody.
   *
   * It was worse than an error: the form said "Registers a person", a worker
   * filled it in, and the submission saved with nothing added to the registry
   * — no warning anywhere, and the people were simply missing from "Find a
   * person". Caught at publish, which is the last point before field workers
   * see it.
   */
  const [owner] = await db
    .select({
      formType: forms.formType,
      subjectTypeId: forms.subjectTypeId,
      audience: forms.audience,
    })
    .from(formVersions)
    .innerJoin(forms, eq(forms.id, formVersions.formId))
    .where(eq(formVersions.id, versionId))
    .limit(1);

  if (owner && owner.formType !== 'standalone' && !owner.subjectTypeId) {
    problems.push({
      message:
        owner.formType === 'registration'
          ? 'This form registers a person, but you have not said who. Choose that above, or change the form to a one-off record.'
          : 'This form records a visit, but you have not said who it is about. Choose that above.',
    });
  }

  /*
   * Every field key the subject type points at must actually exist here.
   *
   * Nothing checked this before, for any of the nominations. Rename or archive
   * a question and the pointer dangles silently: `displayNameFields` starts
   * composing blank names, `matchFields` stops catching duplicates, and — the
   * one that matters — a dangling `dateOfBirthField` makes **every child
   * resolve as an adult**, so guardian consent is never asked for and nothing
   * anywhere says so.
   *
   * Caught at publish, which is the last moment before field workers see it.
   */
  if (owner?.subjectTypeId) {
    const [type] = await db
      .select({
        displayNameFields: subjectTypes.displayNameFields,
        matchFields: subjectTypes.matchFields,
        dateOfBirthField: subjectTypes.dateOfBirthField,
        ageYearsField: subjectTypes.ageYearsField,
        contactField: subjectTypes.contactField,
      })
      .from(subjectTypes)
      .where(eq(subjectTypes.id, owner.subjectTypeId))
      .limit(1);

    if (type) {
      const present = new Set(fields.filter((f) => !f.isArchived).map((f) => f.key));
      const nominated: [string, string][] = [
        ...type.displayNameFields.map((key): [string, string] => [key, 'used to name people in search results']),
        ...type.matchFields.map((key): [string, string] => [key, 'used to spot duplicate records']),
        ...(type.dateOfBirthField ? ([[type.dateOfBirthField, 'used to tell whether someone is a child']] as [string, string][]) : []),
        ...(type.ageYearsField ? ([[type.ageYearsField, 'used to tell whether someone is a child']] as [string, string][]) : []),
        ...(type.contactField ? ([[type.contactField, 'used to reach people if their data is ever exposed']] as [string, string][]) : []),
      ];

      for (const [key, why] of nominated) {
        if (present.has(key)) continue;
        problems.push({
          fieldKey: key,
          message: `Your registry settings expect a question with the key "${key}" (${why}), and this form does not have one.`,
        });
      }
    }
  }

  for (const field of fields) {
    const label = localise(field.label, 'en', field.key);

    // `localise` already falls back through every language, so a blank here
    // means the question has no wording in any language at all.
    if (!label.trim()) {
      problems.push({ fieldKey: field.key, message: 'A question is missing its wording.' });
    }

    if (getFieldType(field.dataType).usesOptions && !field.optionSetId) {
      problems.push({
        fieldKey: field.key,
        message: `"${label}" needs a list of answers to choose from.`,
      });
    }
  }

  return problems;
}

/**
 * Publishes the draft.
 *
 * Freezes the version and points the form at it. The caller then regenerates
 * the analytics views on the *owner* connection — that is DDL, and the
 * request-serving role deliberately has no rights to it.
 */
export async function publishDraft(
  db: DbLike,
  formId: string,
  userId: string,
): Promise<
  | { ok: true; versionId: string; warnings: string[] }
  | { ok: false; problems: PublishProblem[] }
> {
  const [draft] = await db
    .select({ id: formVersions.id })
    .from(formVersions)
    .where(and(eq(formVersions.formId, formId), eq(formVersions.status, 'draft')))
    .limit(1);

  if (!draft) return { ok: false, problems: [{ message: 'There are no unpublished changes.' }] };

  const problems = await validateDraft(db, draft.id);
  if (problems.length > 0) return { ok: false, problems };

  await db
    .update(formVersions)
    .set({ status: 'published', publishedAt: new Date(), publishedBy: userId })
    .where(eq(formVersions.id, draft.id));

  await db.update(forms).set({ currentVersionId: draft.id, updatedAt: new Date() }).where(eq(forms.id, formId));

  /*
   * Turning on "no two records may share this answer" cannot make yesterday's
   * data obey it, and refusing to publish over old data would strand records a
   * field worker actually collected. So publishing succeeds and says plainly
   * what is already there: the rule binds from now on. Silence would leave an
   * admin believing a guarantee the data does not meet.
   */
  const uniqueFields = await db
    .select({ key: formFields.key, label: formFields.label })
    .from(formFields)
    .where(and(eq(formFields.formVersionId, draft.id), eq(formFields.isUnique, true)));

  const warnings: string[] = [];
  for (const field of uniqueFields) {
    const repeats = await countExistingDuplicates(db, formId, field.key);
    if (repeats.length === 0) continue;

    const records = repeats.reduce((total, row) => total + row.count, 0);
    const label = localise(field.label, 'en', field.key);
    warnings.push(
      `"${label}" is now unique, but ${records} records already collected share ${
        repeats.length === 1 ? 'a value' : `${repeats.length} values`
      } (${repeats
        .slice(0, 3)
        .map((row) => row.value)
        .join(', ')}${repeats.length > 3 ? '…' : ''}). They were kept. New entries will be refused.`,
    );
  }

  warnings.push(...(await consentWarnings(db, formId, draft.id)));

  return { ok: true, versionId: draft.id, warnings };
}

/**
 * Says so when a form will collect data and ask nobody's permission.
 *
 * `consentRequirementFor` returns null — and the capture screen shows no
 * consent step at all — when a form's questions are attributed to no purpose
 * needing consent, or when no published notice covers the purposes they are
 * attributed to. Both are legitimate states: an organisation may rest entirely
 * on a Section 7 legitimate use, and asking for consent it cannot honour a
 * withdrawal of is worse than not asking.
 *
 * What is not legitimate is finding out by accident. A brand new organisation
 * has no purposes and no notice, so its first form silently collects children's
 * names with no notice read out and no guardian ever asked — and nothing
 * anywhere says so. This is the moment to say it: the admin is looking at the
 * form, has just decided to send it to their team, and can still act.
 *
 * A warning rather than a refusal, for the reason given on `hasPrivacyContact`:
 * an organisation blocked from collecting anything until the paperwork is right
 * will get the paperwork wrong on purpose, and a checklist gets read where a
 * validation error gets worked around.
 */
async function consentWarnings(
  db: DbLike,
  formId: string,
  versionId: string,
): Promise<string[]> {
  const [org] = await db
    .select({ orgId: forms.orgId })
    .from(forms)
    .where(eq(forms.id, formId))
    .limit(1);
  if (!org) return [];

  const [counts] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE ff.purpose_id IS NULL)::int AS unattributed,
      count(*)::int AS total,
      (
        SELECT count(*)::int
        FROM form_fields f2
        JOIN purposes p ON p.id = f2.purpose_id AND p.is_active
        WHERE f2.form_version_id = ${versionId}::uuid
          AND p.lawful_basis IN ('consent', 'guardian_consent')
      ) AS needing_consent,
      (
        SELECT count(*)::int
        FROM consent_notices n
        JOIN consent_notice_versions v ON v.id = n.current_version_id
        JOIN consent_notice_purposes np ON np.notice_version_id = v.id
        JOIN purposes p ON p.id = np.purpose_id AND p.is_active
        WHERE n.org_id = ${org.orgId}
          AND n.is_active
          AND p.lawful_basis IN ('consent', 'guardian_consent')
      ) AS covered_by_notice
    FROM form_fields ff
    WHERE ff.form_version_id = ${versionId}::uuid
  `)) as unknown as {
    unattributed: number;
    total: number;
    needing_consent: number;
    covered_by_notice: number;
  }[];

  if (!counts || counts.total === 0) return [];

  const out: string[] = [];

  if (counts.unattributed > 0) {
    out.push(
      `${counts.unattributed} of ${counts.total} questions are not attributed to a purpose, so they ` +
        `are left out of your privacy notice. Set one on each under Privacy.`,
    );
  }

  if (counts.needing_consent === 0) {
    out.push(
      'Nobody will be asked for permission on this form: none of its questions rest on consent. ' +
        'If that is wrong, set the lawful basis on the purposes behind them under Privacy.',
    );
  } else if (counts.covered_by_notice === 0) {
    // The one that bites a new organisation, and the one worth spelling out.
    out.push(
      'This form needs consent but you have published no notice covering it, so your team will ' +
        'collect answers without reading anything out and without recording that anyone agreed — ' +
        'including for children. Publish a notice under Privacy.',
    );
  }

  return out;
}

/**
 * Points a form at the kind of subject it registers or visits.
 *
 * Editable after creation because forms built before the registry existed —
 * and any built through the API — can be sitting with no subject type, which
 * makes them silently useless as registrations. Clearing it is allowed only
 * for a standalone form, where it means nothing.
 */
export async function setFormSubjectType(
  db: DbLike,
  orgId: string,
  formId: string,
  subjectTypeId: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (subjectTypeId) {
    // Scoped to the organisation, so an id from another tenant cannot be
    // attached by hand-editing the request.
    const [type] = await db
      .select({ id: subjectTypes.id })
      .from(subjectTypes)
      .where(and(eq(subjectTypes.id, subjectTypeId), eq(subjectTypes.orgId, orgId)))
      .limit(1);
    if (!type) return { ok: false, reason: 'That kind of subject could not be found.' };
  }

  /*
   * Changing it once people are registered would orphan them: their records
   * would claim to be Students while the form that created them now says
   * Household. Adding one where there was none is always safe.
   */
  const [current] = await db
    .select({ subjectTypeId: forms.subjectTypeId })
    .from(forms)
    .where(and(eq(forms.id, formId), eq(forms.orgId, orgId)))
    .limit(1);

  if (!current) return { ok: false, reason: 'That form could not be found.' };

  if (current.subjectTypeId && current.subjectTypeId !== subjectTypeId) {
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subjects)
      .where(eq(subjects.subjectTypeId, current.subjectTypeId));

    if (count > 0) {
      return {
        ok: false,
        reason:
          'People are already registered under the current type, so this cannot be changed. Create a new form instead.',
      };
    }
  }

  await db
    .update(forms)
    .set({ subjectTypeId, updatedAt: new Date() })
    .where(and(eq(forms.id, formId), eq(forms.orgId, orgId)));

  return { ok: true };
}

export async function createForm(
  db: DbLike,
  orgId: string,
  input: {
    slug: string;
    name: I18nText;
    formType: 'registration' | 'encounter' | 'standalone';
    subjectTypeId?: string | null;
  },
): Promise<string> {
  const [form] = await db
    .insert(forms)
    .values({
      orgId,
      slug: input.slug,
      name: input.name,
      formType: input.formType,
      subjectTypeId: input.subjectTypeId ?? null,
    })
    .returning({ id: forms.id });

  return form!.id;
}
