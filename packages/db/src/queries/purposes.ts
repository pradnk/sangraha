import { and, asc, eq, sql } from 'drizzle-orm';
import { toSnakeCase, type I18nText } from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { purposes } from '../schema/compliance';
import { formFields, formVersions, forms } from '../schema/config';

/**
 * Why an organisation collects things.
 *
 * The unit consent is given against, because the Act requires consent to be
 * *specific*: "do you agree to us holding your data" is consent to nothing. A
 * purpose is the sentence that makes the question answerable — "to run the
 * mid-day meal programme".
 */

export type LawfulBasis =
  | 'consent'
  | 'guardian_consent'
  | 'voluntary'
  | 'state_benefit'
  | 'medical_emergency'
  | 'employment';

/**
 * Whether relying on this basis means asking the person.
 *
 * The distinction the UI turns on. Under a legitimate use there is nothing to
 * ask and nothing to withdraw, so offering a consent step would collect a
 * meaningless answer — and offering a withdrawal button would promise something
 * the organisation cannot honour.
 */
export const REQUIRES_CONSENT: Record<LawfulBasis, boolean> = {
  consent: true,
  guardian_consent: true,
  voluntary: false,
  state_benefit: false,
  medical_emergency: false,
  employment: false,
};

export interface Purpose {
  id: string;
  code: string;
  name: I18nText;
  description: I18nText | null;
  lawfulBasis: LawfulBasis;
  retentionMonths: number | null;
  retentionStatute: string | null;
  isActive: boolean;
}

export async function listPurposes(db: DbLike, orgId: string): Promise<Purpose[]> {
  const rows = await db
    .select({
      id: purposes.id,
      code: purposes.code,
      name: purposes.name,
      description: purposes.description,
      lawfulBasis: purposes.lawfulBasis,
      retentionMonths: purposes.retentionMonths,
      retentionStatute: purposes.retentionStatute,
      isActive: purposes.isActive,
    })
    .from(purposes)
    .where(eq(purposes.orgId, orgId))
    .orderBy(asc(purposes.code));

  return rows as Purpose[];
}

export interface NewPurpose {
  code?: string;
  name: I18nText;
  description?: I18nText | null;
  lawfulBasis?: LawfulBasis;
  retentionMonths?: number | null;
  retentionStatute?: string | null;
}

/**
 * Creates a purpose, deriving the code from the name if none was given.
 *
 * Derived once, at creation, and then immutable — the same contract as
 * `forms.slug`. It names an analytics column and a CSV header, so re-deriving
 * it from a later, translated or reworded name would silently rename a column
 * that reports depend on.
 */
export async function createPurpose(
  db: DbLike,
  orgId: string,
  input: NewPurpose,
): Promise<string> {
  const base = input.code?.trim() || toSnakeCase(input.name.en ?? Object.values(input.name)[0] ?? 'purpose');

  const [row] = await db
    .insert(purposes)
    .values({
      orgId,
      code: base,
      name: input.name,
      description: input.description ?? null,
      lawfulBasis: input.lawfulBasis ?? 'consent',
      retentionMonths: input.retentionMonths ?? null,
      retentionStatute: input.retentionStatute ?? null,
    })
    .returning({ id: purposes.id });

  return row!.id;
}

export async function updatePurpose(
  db: DbLike,
  orgId: string,
  id: string,
  patch: Partial<Omit<Purpose, 'id' | 'code'>>,
): Promise<void> {
  // `code` is deliberately absent from the patch type. It is immutable.
  await db
    .update(purposes)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(purposes.id, id), eq(purposes.orgId, orgId)));
}

export interface PurposeCoverage {
  purposeId: string | null;
  purposeCode: string | null;
  purposeName: I18nText | null;
  /** Field keys attributed to it, with the wording for the notice. */
  fields: { key: string; label: I18nText; dataDescription: I18nText | null }[];
}

/**
 * What each purpose actually collects, across an organisation's live forms.
 *
 * The input to notice generation, and the reason a notice does not have to be
 * written from a blank page: the system already knows every question it asks.
 *
 * Reads the *published* version of each active form — a draft is not yet
 * collecting anything, and a notice describing questions nobody is being asked
 * is both wrong and alarming. Fields with no purpose come back under a null
 * purpose so the caller can say what is unaccounted for rather than quietly
 * omitting it.
 */
export async function purposeCoverage(db: DbLike, orgId: string): Promise<PurposeCoverage[]> {
  const rows = (await db.execute(sql`
    SELECT
      p.id   AS purpose_id,
      p.code AS purpose_code,
      p.name AS purpose_name,
      ff.key AS field_key,
      ff.label AS field_label,
      ff.data_description AS field_description
    FROM forms f
    JOIN form_versions fv ON fv.id = f.current_version_id
    JOIN form_fields ff ON ff.form_version_id = fv.id
    LEFT JOIN purposes p ON p.id = ff.purpose_id
    WHERE f.org_id = ${orgId}
      AND f.is_active
      AND NOT ff.is_archived
      -- A repeat group holds no answer of its own; its children are listed.
      AND ff.data_type <> 'repeat_group'
    ORDER BY p.code NULLS LAST, ff.sort_order
  `)) as unknown as Record<string, unknown>[];

  const byPurpose = new Map<string, PurposeCoverage>();

  for (const row of rows) {
    const key = (row.purpose_id as string) ?? '__unattributed';
    let entry = byPurpose.get(key);
    if (!entry) {
      entry = {
        purposeId: (row.purpose_id as string) ?? null,
        purposeCode: (row.purpose_code as string) ?? null,
        purposeName: (row.purpose_name as I18nText) ?? null,
        fields: [],
      };
      byPurpose.set(key, entry);
    }

    // The same question can appear on several forms; describe it once.
    if (entry.fields.some((field) => field.key === row.field_key)) continue;
    entry.fields.push({
      key: row.field_key as string,
      label: (row.field_label as I18nText) ?? {},
      dataDescription: (row.field_description as I18nText) ?? null,
    });
  }

  return [...byPurpose.values()];
}

/**
 * Questions being asked that no purpose accounts for.
 *
 * Surfaced at publish as a warning rather than an error, because the first
 * release must not block an organisation from publishing a form it already
 * relies on. It is what stops a notice quietly going out of date as forms grow.
 */
export async function unattributedFields(
  db: DbLike,
  orgId: string,
): Promise<{ formSlug: string; key: string; label: I18nText }[]> {
  const rows = await db
    .select({
      formSlug: forms.slug,
      key: formFields.key,
      label: formFields.label,
    })
    .from(formFields)
    .innerJoin(formVersions, eq(formVersions.id, formFields.formVersionId))
    .innerJoin(forms, eq(forms.id, formVersions.formId))
    .where(
      and(
        eq(forms.orgId, orgId),
        eq(forms.isActive, true),
        eq(formVersions.id, sql`${forms.currentVersionId}`),
        eq(formFields.isArchived, false),
        sql`${formFields.purposeId} IS NULL`,
        sql`${formFields.dataType} <> 'repeat_group'`,
      ),
    )
    .orderBy(asc(forms.slug), asc(formFields.sortOrder));

  return rows as { formSlug: string; key: string; label: I18nText }[];
}
