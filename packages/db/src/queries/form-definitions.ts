import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  FieldDefinition,
  FormVersionDefinition,
  OptionSetDefinition,
} from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { formFields, formVersions, forms, options, optionSets } from '../schema/index';

/**
 * Loads form versions in the shape `@sangraha/form-engine` expects.
 *
 * One loader for every consumer — the capture UI, request validation, CSV
 * export and the analytics view generator all read a form through here, so
 * there is no second interpretation of what a form is.
 */
export async function loadFormVersionDefinitions(
  db: DbLike,
  formId: string,
  opts: { includeDrafts?: boolean } = {},
): Promise<FormVersionDefinition[]> {
  const [form] = await db.select().from(forms).where(eq(forms.id, formId)).limit(1);
  if (!form) return [];

  const versionRows = await db
    .select()
    .from(formVersions)
    .where(
      opts.includeDrafts
        ? eq(formVersions.formId, formId)
        : and(eq(formVersions.formId, formId), eq(formVersions.status, 'published')),
    )
    .orderBy(asc(formVersions.versionNumber));

  if (versionRows.length === 0) return [];

  const fieldRows = await db
    .select()
    .from(formFields)
    .where(
      inArray(
        formFields.formVersionId,
        versionRows.map((v) => v.id),
      ),
    )
    .orderBy(asc(formFields.sortOrder));

  const optionSetsById = await loadOptionSets(
    db,
    fieldRows.map((f) => f.optionSetId).filter((id): id is string => id !== null),
  );

  return versionRows.map((version) => ({
    id: version.id,
    formId: form.id,
    formSlug: form.slug,
    versionNumber: version.versionNumber,
    name: form.name,
    description: form.description ?? null,
    formType: form.formType,
    subjectTypeId: form.subjectTypeId ?? null,
    fields: fieldRows
      .filter((f) => f.formVersionId === version.id)
      .map((f): FieldDefinition => ({
        id: f.id,
        key: f.key,
        label: f.label,
        help: f.help ?? null,
        dataType: f.dataType,
        isRequired: f.isRequired,
        isUnique: f.isUnique,
        sortOrder: f.sortOrder,
        parentGroupId: f.parentGroupId ?? null,
        optionSet: f.optionSetId ? (optionSetsById.get(f.optionSetId) ?? null) : null,
        config: f.config,
        visibilityRule: f.visibilityRule ?? null,
        isArchived: f.isArchived,
        labelMachine: f.labelMachine ?? null,
        helpMachine: f.helpMachine ?? null,
        purposeId: f.purposeId ?? null,
        dataDescription: f.dataDescription ?? null,
      })),
  }));
}

/** The version field workers currently receive, or null if never published. */
export async function loadCurrentFormVersion(
  db: DbLike,
  formId: string,
): Promise<FormVersionDefinition | null> {
  const versions = await loadFormVersionDefinitions(db, formId);
  return versions.at(-1) ?? null;
}

/** Loads one specific version — used when re-validating an existing submission. */
export async function loadFormVersionById(
  db: DbLike,
  formVersionId: string,
): Promise<FormVersionDefinition | null> {
  const [version] = await db
    .select({ formId: formVersions.formId })
    .from(formVersions)
    .where(eq(formVersions.id, formVersionId))
    .limit(1);
  if (!version) return null;

  const all = await loadFormVersionDefinitions(db, version.formId, { includeDrafts: true });
  return all.find((v) => v.id === formVersionId) ?? null;
}

async function loadOptionSets(
  db: DbLike,
  optionSetIds: string[],
): Promise<Map<string, OptionSetDefinition>> {
  const unique = [...new Set(optionSetIds)];
  if (unique.length === 0) return new Map();

  const [setRows, optionRows] = await Promise.all([
    db.select().from(optionSets).where(inArray(optionSets.id, unique)),
    db
      .select()
      .from(options)
      .where(inArray(options.optionSetId, unique))
      .orderBy(asc(options.sortOrder)),
  ]);

  return new Map(
    setRows.map((set) => [
      set.id,
      {
        id: set.id,
        code: set.code,
        name: set.name,
        options: optionRows
          .filter((o) => o.optionSetId === set.id)
          .map((o) => ({
            code: o.code,
            label: o.label,
            imageUrl: o.imageUrl,
            sortOrder: o.sortOrder,
            isActive: o.isActive,
          })),
      },
    ]),
  );
}
