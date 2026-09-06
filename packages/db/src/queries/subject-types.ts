import { and, asc, count, eq, sql } from 'drizzle-orm';
import { localise, toSnakeCase, type I18nText } from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { formFields, formVersions, forms, subjectTypes } from '../schema/config';
import { subjects } from '../schema/data';

/**
 * Subject types — what an organisation registers.
 *
 * Student, Household, Woman, Self-Help Group, School. Entirely org-defined,
 * because a product that shipped a fixed list of "beneficiary kinds" would be
 * wrong for the second NGO that used it.
 *
 * Two of the columns here decide how the registry behaves, and both are chosen
 * by the admin rather than guessed:
 *
 *   display_name_fields  which answers compose the name a field worker sees in
 *                        a search result
 *   match_fields         which answers must match exactly for two records to be
 *                        flagged as the same person
 */

export interface SubjectTypeDetail {
  id: string;
  code: string;
  name: I18nText;
  icon: string | null;
  displayNameFields: string[];
  matchFields: string[];
  /** Where a birth date lives, so the system can tell whether this is a child. */
  dateOfBirthField: string | null;
  /** A recorded age, for the many registrations that have no birth date. */
  ageYearsField: string | null;
  /** How to reach this person if their data is ever exposed. */
  contactField: string | null;
  isActive: boolean;
  /** How many people, households or groups are registered under it. */
  subjectCount: number;
  /** The registration form pointed at this type, if any. */
  registrationForm: { id: string; slug: string; name: I18nText } | null;
  /** Encounter forms that attach to it. */
  encounterForms: { id: string; slug: string; name: I18nText }[];
}

export async function listSubjectTypes(
  db: DbLike,
  orgId: string,
): Promise<SubjectTypeDetail[]> {
  const types = await db
    .select()
    .from(subjectTypes)
    .where(eq(subjectTypes.orgId, orgId))
    .orderBy(asc(subjectTypes.code));

  if (types.length === 0) return [];

  const attachedForms = await db
    .select({
      id: forms.id,
      slug: forms.slug,
      name: forms.name,
      formType: forms.formType,
      subjectTypeId: forms.subjectTypeId,
    })
    .from(forms)
    .where(and(eq(forms.orgId, orgId), eq(forms.isActive, true)));

  const counts = await db
    .select({ subjectTypeId: subjects.subjectTypeId, total: count() })
    .from(subjects)
    .where(and(eq(subjects.orgId, orgId), sql`${subjects.deletedAt} IS NULL`))
    .groupBy(subjects.subjectTypeId);

  const countByType = new Map(counts.map((row) => [row.subjectTypeId, Number(row.total)]));

  return types.map((type) => ({
    id: type.id,
    code: type.code,
    name: type.name,
    icon: type.icon,
    displayNameFields: type.displayNameFields,
    matchFields: type.matchFields,
    dateOfBirthField: type.dateOfBirthField,
    ageYearsField: type.ageYearsField,
    contactField: type.contactField,
    isActive: type.isActive,
    subjectCount: countByType.get(type.id) ?? 0,
    registrationForm:
      attachedForms.find((f) => f.subjectTypeId === type.id && f.formType === 'registration') ??
      null,
    encounterForms: attachedForms.filter(
      (f) => f.subjectTypeId === type.id && f.formType === 'encounter',
    ),
  }));
}

/**
 * The answers available to compose a name from, or match on.
 *
 * Read from the registration form's current version, because those are the only
 * answers a subject will actually have. Offering every field in the
 * organisation would let an admin pick one that is never filled in.
 */
export async function listRegistrationFields(
  db: DbLike,
  orgId: string,
  subjectTypeId: string,
): Promise<{ key: string; label: I18nText; dataType: string }[]> {
  const [form] = await db
    .select({ id: forms.id, currentVersionId: forms.currentVersionId })
    .from(forms)
    .where(
      and(
        eq(forms.orgId, orgId),
        eq(forms.subjectTypeId, subjectTypeId),
        eq(forms.formType, 'registration'),
      ),
    )
    .limit(1);

  if (!form) return [];

  // Falls back to the newest version when nothing is published yet, so an admin
  // can configure the type while still building the form.
  let versionId = form.currentVersionId;
  if (!versionId) {
    const [latest] = await db
      .select({ id: formVersions.id })
      .from(formVersions)
      .where(eq(formVersions.formId, form.id))
      .orderBy(sql`${formVersions.versionNumber} DESC`)
      .limit(1);
    versionId = latest?.id ?? null;
  }
  if (!versionId) return [];

  const fields = await db
    .select({ key: formFields.key, label: formFields.label, dataType: formFields.dataType })
    .from(formFields)
    .where(and(eq(formFields.formVersionId, versionId), eq(formFields.isArchived, false)))
    .orderBy(asc(formFields.sortOrder));

  // A repeating section has no single value to name someone by.
  return fields.filter((field) => field.dataType !== 'repeat_group');
}

export type CreateSubjectTypeResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'code_taken' | 'invalid_name' };

export async function createSubjectType(
  db: DbLike,
  orgId: string,
  name: I18nText,
): Promise<CreateSubjectTypeResult> {
  const base = toSnakeCase(localise(name, 'en')).slice(0, 50);
  if (!base) return { ok: false, reason: 'invalid_name' };

  const taken = new Set(
    (
      await db
        .select({ code: subjectTypes.code })
        .from(subjectTypes)
        .where(eq(subjectTypes.orgId, orgId))
    ).map((row) => row.code),
  );

  // The code names API paths and the analytics dimension, and is permanent —
  // so a collision is resolved here rather than surfaced to the admin.
  let code = base;
  let suffix = 2;
  while (taken.has(code)) code = `${base}_${suffix++}`;

  const [created] = await db
    .insert(subjectTypes)
    .values({ orgId, code, name })
    .returning({ id: subjectTypes.id });

  return { ok: true, id: created!.id };
}

export async function updateSubjectType(
  db: DbLike,
  id: string,
  patch: {
    name?: I18nText;
    icon?: string | null;
    displayNameFields?: string[];
    matchFields?: string[];
    dateOfBirthField?: string | null;
    ageYearsField?: string | null;
    contactField?: string | null;
    isActive?: boolean;
  },
): Promise<void> {
  await db
    .update(subjectTypes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(subjectTypes.id, id));
}

export type DeleteSubjectTypeResult = { ok: true } | { ok: false; reason: string };

/**
 * Deletes a subject type, or refuses because something depends on it.
 *
 * Same shape as everywhere else in the product: refuse and explain, offer
 * switching it off instead. A type with people registered under it cannot go
 * without taking them with it.
 */
export async function deleteSubjectType(
  db: DbLike,
  orgId: string,
  id: string,
): Promise<DeleteSubjectTypeResult> {
  const [registered] = await db
    .select({ total: count() })
    .from(subjects)
    .where(and(eq(subjects.subjectTypeId, id), sql`${subjects.deletedAt} IS NULL`));

  if (Number(registered?.total ?? 0) > 0) {
    return {
      ok: false,
      reason: `${registered!.total} ${Number(registered!.total) === 1 ? 'person is' : 'people are'} registered under this. Switch it off instead — it stops being offered, and their records stay.`,
    };
  }

  const [attached] = await db
    .select({ total: count() })
    .from(forms)
    .where(and(eq(forms.orgId, orgId), eq(forms.subjectTypeId, id)));

  if (Number(attached?.total ?? 0) > 0) {
    return {
      ok: false,
      reason: `${attached!.total} form${Number(attached!.total) === 1 ? '' : 's'} still use this. Point them elsewhere first.`,
    };
  }

  await db.delete(subjectTypes).where(eq(subjectTypes.id, id));
  return { ok: true };
}

/**
 * Builds the name a field worker will see in a search result.
 *
 * Falls back to the type's own name when the admin has not chosen any fields,
 * so a subject is never nameless — an unnamed row in a "find a person" list is
 * useless to the person searching.
 */
export function composeDisplayName(
  displayNameFields: string[],
  answers: Record<string, unknown>,
  fallback: string,
): string {
  const parts = displayNameFields
    .map((key) => answers[key])
    .filter((value): value is string | number => value !== null && value !== undefined && value !== '')
    .map((value) => String(value).trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(' ') : fallback;
}
