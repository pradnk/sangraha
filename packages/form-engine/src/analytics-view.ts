import './field-types/index';

import { getFieldType, pgIdentifier, pgLiteral, type SqlContext } from './registry';
import { resolveFieldConfig } from './validation';
import type {
  FieldDataType,
  FieldDefinition,
  FormVersionDefinition,
  I18nText,
  OptionSetDefinition,
} from './types';

/** Postgres caps identifiers at 63 bytes; anything longer is silently truncated. */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * View names the registry owns.
 *
 * A form slugged `subjects` is perfectly legal, and without this its main view
 * would silently replace the registry dimension every BI join depends on. The
 * form yields `subjects_form` instead; the registry keeps the plain name,
 * because that is the one written into other people's queries.
 */
const RESERVED_VIEW_NAMES = new Set(['subjects']);

/** Core registry columns, shared by the dimension views. */
function subjectColumns(alias: string): GeneratedColumn[] {
  return [
    { name: 'subject_id', pgType: 'uuid', expression: `${alias}.id` },
    { name: 'org_id', pgType: 'uuid', expression: `${alias}.org_id` },
    { name: 'subject_type_id', pgType: 'uuid', expression: `${alias}.subject_type_id` },
    { name: 'subject_type', pgType: 'text', expression: 'st.code' },
    { name: 'display_name', pgType: 'text', expression: `${alias}.display_name` },
    { name: 'external_id', pgType: 'text', expression: `${alias}.external_id` },
    { name: 'location_id', pgType: 'uuid', expression: `${alias}.location_id` },
    { name: 'location_path', pgType: 'text', expression: 'loc.path::text' },
    { name: 'status', pgType: 'text', expression: `${alias}.status::text` },
    { name: 'registered_at', pgType: 'timestamptz', expression: `${alias}.registered_at` },
    /*
     * Duplicates are linked, never merged, so both rows are still here. These
     * two columns are how a report avoids counting one person twice:
     * `WHERE NOT is_duplicate` for a headcount, or GROUP BY `canonical_id` to
     * roll a person's two records together.
     */
    { name: 'canonical_id', pgType: 'uuid', expression: `COALESCE(${alias}.duplicate_of_id, ${alias}.id)` },
    { name: 'is_duplicate', pgType: 'boolean', expression: `(${alias}.duplicate_of_id IS NOT NULL)` },
    { name: 'created_at', pgType: 'timestamptz', expression: `${alias}.created_at` },
    { name: 'updated_at', pgType: 'timestamptz', expression: `${alias}.updated_at` },
  ];
}

const SUBJECT_FROM = (orgId: string) =>
  [
    `FROM public.subjects subj`,
    `JOIN public.subject_types st ON st.id = subj.subject_type_id`,
    `LEFT JOIN public.locations loc ON loc.id = subj.location_id`,
    `WHERE subj.org_id = ${pgLiteral(orgId)}`,
    `  AND subj.deleted_at IS NULL`,
  ];

/**
 * The registry dimension: every registered person, one row each.
 *
 * Encounter views already carry `subject_id`, so this is the join that turns a
 * pile of visit records into "how did this child progress over the year?" —
 * the question the whole registry exists to answer, and the one no per-form
 * view can answer on its own.
 */
export function generateSubjectsBaseView(orgId: string, schema: string): GeneratedView {
  const columns = subjectColumns('subj');
  const sql = [
    `CREATE OR REPLACE VIEW ${pgIdentifier(schema)}.${pgIdentifier('subjects')} AS`,
    `SELECT`,
    columns.map((c) => `  ${c.expression} AS ${pgIdentifier(c.name)}`).join(',\n'),
    ...SUBJECT_FROM(orgId),
  ].join('\n') + ';';

  return { name: 'subjects', schema, repeatGroupKey: null, columns, sql };
}

export interface GenerateSubjectTypeViewOptions {
  orgId: string;
  subjectTypeId: string;
  /** Immutable subject-type code; names the view. */
  subjectTypeCode: string;
  schema: string;
  /** Every published version of that type's registration form. */
  versions: FormVersionDefinition[];
  labelLocale?: string;
}

/**
 * One view per kind of subject, with the registration answers flattened.
 *
 * Split by type rather than folded into `subjects` because a Student and a
 * Household are registered with different forms: a single wide view would
 * either collide on shared field keys or be mostly NULL.
 */
export function generateSubjectTypeView(
  options: GenerateSubjectTypeViewOptions,
): GeneratedView {
  const locale = options.labelLocale ?? 'en';
  const name = truncateIdentifier(`subjects_${toSnakeCase(options.subjectTypeCode)}`);

  const columns = subjectColumns('subj');
  const used = new Set(columns.map((c) => c.name));

  // Registration answers live on the subject itself, copied there at
  // registration, so this reads `subj.attributes` rather than joining back to
  // the submission — which keeps the view valid even if the form is retired.
  const fields = mergeFieldsAcrossVersions(options.versions).filter(
    (f) => !f.parentGroupId,
  );
  columns.push(...fieldColumns(fields, 'subj.attributes', 'subj.org_id', locale, used));

  const sql = [
    `CREATE OR REPLACE VIEW ${pgIdentifier(options.schema)}.${pgIdentifier(name)} AS`,
    `SELECT`,
    columns.map((c) => `  ${c.expression} AS ${pgIdentifier(c.name)}`).join(',\n'),
    ...SUBJECT_FROM(options.orgId),
    `  AND subj.subject_type_id = ${pgLiteral(options.subjectTypeId)}`,
  ].join('\n') + ';';

  return { name, schema: options.schema, repeatGroupKey: null, columns, sql };
}

export interface GeneratedColumn {
  name: string;
  pgType: string;
  expression: string;
  /**
   * The question this column came from, absent on the fixed columns.
   *
   * Carried here rather than re-derived by whoever needs a label, because the
   * name is `toSnakeCase(key) + suffix` put through `uniqueIdentifier` against
   * a *mutating* set of names already taken. Two keys that collide after
   * `toSnakeCase` get `_2` appended to the second, and which one that is
   * depends on field order — so a second implementation elsewhere lines the
   * labels up against the wrong columns, and only for the forms unlucky enough
   * to have a collision.
   */
  source?: ColumnSource;
}

export interface ColumnSource {
  fieldKey: string;
  label: I18nText;
  dataType: FieldDataType;
  /** `''` for the field's own column, `_label` and the like for companions. */
  suffix: string;
  optionSet?: OptionSetDefinition | null;
}

export interface GeneratedView {
  /** Unqualified view name within `schema`. */
  name: string;
  /** Schema the view lives in — one per organisation. */
  schema: string;
  /** Set for a repeat group's child view; null for the form's main view. */
  repeatGroupKey: string | null;
  columns: GeneratedColumn[];
  sql: string;
}

export interface GenerateViewsOptions {
  formId: string;
  formSlug: string;
  /**
   * Schema to create the views in, one per organisation
   * (`analytics_shiksha_demo`).
   *
   * Form slugs are only unique within an organisation, so a single shared
   * schema would let two NGOs that both build a `school_attendance` form
   * silently overwrite each other's view. Separate schemas also make the
   * read-only BI grant trivial: an org's reader role gets USAGE on exactly one
   * schema and can reach nothing else.
   */
  schema: string;
  /** Every published version of the form, in any order. */
  versions: FormVersionDefinition[];
  /** Locale used for the inlined `_label` columns on choice fields. */
  labelLocale?: string;
}

/**
 * Builds the analytics views for one form.
 *
 * Submissions from every version of a form live in the same table, so there is
 * no UNION here: the view simply extracts the union of all field keys ever
 * published. A row saved before a question existed yields NULL for it, and a
 * renamed label changes nothing at all, because columns are named after the
 * immutable field `key`.
 */
export function generateFormViews(options: GenerateViewsOptions): GeneratedView[] {
  const { formId, formSlug, schema, versions } = options;
  const locale = options.labelLocale ?? 'en';
  const fields = mergeFieldsAcrossVersions(versions);

  const topLevel = fields.filter((f) => !f.parentGroupId);
  const groups = topLevel.filter((f) => getFieldType(f.dataType).isContainer);

  const views: GeneratedView[] = [
    buildMainView(formId, formSlug, schema, topLevel, locale),
  ];

  for (const group of groups) {
    const children = fields.filter((f) => f.parentGroupId === group.id);
    if (children.length > 0) {
      views.push(buildRepeatView(formId, formSlug, schema, group, children, locale));
    }
  }

  return views;
}

/** Derives an organisation's analytics schema name from its slug. */
export function analyticsSchemaName(orgSlug: string): string {
  return truncateIdentifier(`analytics_${toSnakeCase(orgSlug)}`);
}

/**
 * Collapses every published version into one field list keyed by field `key`.
 *
 * The most recent definition of a key wins, because that is where the current
 * label, option set and config live. Keys that existed only in older versions
 * are retained so their historical answers stay visible.
 */
function mergeFieldsAcrossVersions(versions: FormVersionDefinition[]): FieldDefinition[] {
  const ordered = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);
  const byKey = new Map<string, FieldDefinition>();
  // Group membership is tracked by key rather than id, since a repeat group
  // gets a fresh row id in every version.
  const groupIdToKey = new Map<string, string>();

  for (const version of ordered) {
    for (const field of version.fields) {
      if (getFieldType(field.dataType).isContainer) groupIdToKey.set(field.id, field.key);
    }
    for (const field of version.fields) {
      const parentKey = field.parentGroupId ? groupIdToKey.get(field.parentGroupId) : null;
      byKey.set(scopedKey(parentKey, field.key), {
        ...field,
        // Re-point ids to keys so the merged list is internally consistent.
        id: field.key,
        parentGroupId: parentKey ?? null,
      });
    }
  }

  return [...byKey.values()];
}

const scopedKey = (parentKey: string | null | undefined, key: string): string =>
  parentKey ? `${parentKey}.${key}` : key;

/**
 * What the main view's columns are, without building any SQL.
 *
 * Exported so a screen can label a column with the question it came from. It
 * shares `mainViewColumns` with `buildMainView` rather than reproducing the
 * rules, which is the whole point: see the note on `GeneratedColumn.source`.
 *
 * Takes every published version, as the view does, so a question that existed
 * only in version 1 is still described.
 */
export function describeMainViewColumns(
  versions: FormVersionDefinition[],
  labelLocale = 'en',
): GeneratedColumn[] {
  const fields = mergeFieldsAcrossVersions(versions).filter((f) => !f.parentGroupId);
  return mainViewColumns(fields, labelLocale);
}

/** The name a form's main view gets, allowing for the reserved one. */
export function mainViewName(formSlug: string): string {
  const base = truncateIdentifier(toSnakeCase(formSlug));
  return RESERVED_VIEW_NAMES.has(base) ? truncateIdentifier(`${base}_form`) : base;
}

/** The one definition of what columns a main view has, and in what order. */
function mainViewColumns(
  topLevel: FieldDefinition[],
  labelLocale: string,
): GeneratedColumn[] {
  const used = new Set<string>();

  const columns: GeneratedColumn[] = [
    { name: 'submission_id', pgType: 'uuid', expression: 's.id' },
    { name: 'org_id', pgType: 'uuid', expression: 's.org_id' },
    { name: 'subject_id', pgType: 'uuid', expression: 's.subject_id' },
    { name: 'form_version', pgType: 'integer', expression: 'fv.version_number' },
    { name: 'status', pgType: 'text', expression: 's.status::text' },
    { name: 'submitted_by', pgType: 'uuid', expression: 's.submitted_by' },
    { name: 'submitted_at', pgType: 'timestamptz', expression: 's.submitted_at' },
    { name: 'reviewed_by', pgType: 'uuid', expression: 's.reviewed_by' },
    { name: 'reviewed_at', pgType: 'timestamptz', expression: 's.reviewed_at' },
    /*
     * An org admin may approve a record they captured themselves — there may
     * be nobody else in the organisation to do it. Surfaced rather than
     * hidden, so an audit can count every instance instead of taking the
     * review step on trust.
     */
    {
      name: 'self_reviewed',
      pgType: 'boolean',
      expression: '(s.reviewed_by IS NOT NULL AND s.reviewed_by = s.submitted_by)',
    },
    { name: 'location_id', pgType: 'uuid', expression: 's.location_id' },
    { name: 'created_at', pgType: 'timestamptz', expression: 's.created_at' },
    { name: 'updated_at', pgType: 'timestamptz', expression: 's.updated_at' },
  ];
  columns.forEach((c) => used.add(c.name));
  columns.push(...fieldColumns(topLevel, 's.data', 's.org_id', labelLocale, used));

  return columns;
}

function buildMainView(
  formId: string,
  formSlug: string,
  schema: string,
  topLevel: FieldDefinition[],
  labelLocale: string,
): GeneratedView {
  const name = mainViewName(formSlug);
  const columns = mainViewColumns(topLevel, labelLocale);

  const sql = [
    `CREATE OR REPLACE VIEW ${pgIdentifier(schema)}.${pgIdentifier(name)} AS`,
    `SELECT`,
    columns.map((c) => `  ${c.expression} AS ${pgIdentifier(c.name)}`).join(',\n'),
    `FROM public.submissions s`,
    `JOIN public.form_versions fv ON fv.id = s.form_version_id`,
    // Drafts are excluded because they are partially filled by definition.
    // Everything else is exposed with its `status`, so an organisation that
    // uses supervisor approval can filter and one that does not still sees
    // its data.
    `WHERE s.form_id = ${pgLiteral(formId)}`,
    `  AND s.status <> 'draft'`,
    `  AND s.deleted_at IS NULL;`,
  ].join('\n');

  return { name, schema, repeatGroupKey: null, columns, sql };
}

/**
 * Builds the child view for a repeating section.
 *
 * Each entry in the repeat becomes its own row, joined back to the parent via
 * `submission_id`. This is what keeps the output relational: a household survey
 * with five members yields five rows in `<form>__members`, not one row with a
 * nested blob.
 */
function buildRepeatView(
  formId: string,
  formSlug: string,
  schema: string,
  group: FieldDefinition,
  children: FieldDefinition[],
  labelLocale: string,
): GeneratedView {
  const name = truncateIdentifier(`${toSnakeCase(formSlug)}__${toSnakeCase(group.key)}`);
  const used = new Set<string>();
  const groupKeyLiteral = pgLiteral(group.key);

  const columns: GeneratedColumn[] = [
    // Stable surrogate key so BI tools that demand a unique row identifier
    // (and incremental warehouse syncs) have one.
    {
      name: 'entry_id',
      pgType: 'text',
      expression: `s.id::text || '#' || entry.ordinality::text`,
    },
    { name: 'submission_id', pgType: 'uuid', expression: 's.id' },
    { name: 'org_id', pgType: 'uuid', expression: 's.org_id' },
    { name: 'subject_id', pgType: 'uuid', expression: 's.subject_id' },
    { name: 'entry_index', pgType: 'integer', expression: 'entry.ordinality::integer' },
    { name: 'form_version', pgType: 'integer', expression: 'fv.version_number' },
    { name: 'submitted_at', pgType: 'timestamptz', expression: 's.submitted_at' },
    { name: 'location_id', pgType: 'uuid', expression: 's.location_id' },
  ];
  columns.forEach((c) => used.add(c.name));
  columns.push(...fieldColumns(children, 'entry.value', 's.org_id', labelLocale, used));

  const sql = [
    `CREATE OR REPLACE VIEW ${pgIdentifier(schema)}.${pgIdentifier(name)} AS`,
    `SELECT`,
    columns.map((c) => `  ${c.expression} AS ${pgIdentifier(c.name)}`).join(',\n'),
    `FROM public.submissions s`,
    `JOIN public.form_versions fv ON fv.id = s.form_version_id`,
    // The CASE guards against a submission where the repeat key holds
    // something other than an array; jsonb_array_elements would otherwise
    // raise and take the whole view down.
    `CROSS JOIN LATERAL jsonb_array_elements(`,
    `  CASE WHEN jsonb_typeof(s.data->${groupKeyLiteral}) = 'array'`,
    `       THEN s.data->${groupKeyLiteral}`,
    `       ELSE '[]'::jsonb END`,
    `) WITH ORDINALITY AS entry(value, ordinality)`,
    `WHERE s.form_id = ${pgLiteral(formId)}`,
    `  AND s.status <> 'draft'`,
    `  AND s.deleted_at IS NULL;`,
  ].join('\n');

  return { name, schema, repeatGroupKey: group.key, columns, sql };
}

function fieldColumns(
  fields: FieldDefinition[],
  dataExpression: string,
  /**
   * The row's own organisation, e.g. `s.org_id`.
   *
   * Passed per builder rather than assumed: the three views here are built over
   * different tables under different aliases, and a field type that reaches
   * into another table needs the right one. Hardcoding `s.org_id` made the
   * subject dimension view — which is `FROM public.subjects subj`, with no `s`
   * at all — fail to create.
   */
  orgExpression: string,
  labelLocale: string,
  used: Set<string>,
): GeneratedColumn[] {
  const columns: GeneratedColumn[] = [];

  for (const field of [...fields].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const definition = getFieldType(field.dataType);
    if (definition.isContainer) continue; // gets its own child view

    const config = resolveFieldConfig(field);
    const context: SqlContext = {
      data: dataExpression,
      field,
      literal: pgLiteral,
      submissionOrg: orgExpression,
    };

    for (const column of definition.analyticsColumns(field, config as never)) {
      const name = uniqueIdentifier(toSnakeCase(field.key) + column.suffix, used);
      columns.push({
        name,
        pgType: column.pgType,
        expression: column.expr(context),
        source: {
          fieldKey: field.key,
          label: field.label,
          dataType: field.dataType,
          suffix: column.suffix,
          optionSet: field.optionSet ?? null,
        },
      });
    }
  }

  return columns;
}

/** Field keys are already slug-like; this guards against imported or legacy keys. */
export function toSnakeCase(value: string): string {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      /*
       * Apostrophes are removed rather than treated as a separator. Labels in
       * this product are full questions — "Guardian's phone", "Child's name" —
       * and splitting on the apostrophe produced `guardian_s_phone`, which then
       * became the CSV header an NGO sends to a funder. Curly apostrophes count
       * too: a label pasted from Word is the common case, not the rare one.
       */
      .replace(/['’`]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
  );
}

function truncateIdentifier(value: string): string {
  return value.length <= MAX_IDENTIFIER_LENGTH ? value : value.slice(0, MAX_IDENTIFIER_LENGTH);
}

/**
 * Guarantees a distinct column name.
 *
 * Collisions are rare but real: a `caste` multi-choice emits `caste_sc`, and a
 * separate `caste_sc` yes/no question would otherwise silently overwrite it.
 */
function uniqueIdentifier(candidate: string, used: Set<string>): string {
  let name = truncateIdentifier(candidate);
  let suffix = 2;
  while (used.has(name)) {
    const tag = `_${suffix++}`;
    name = truncateIdentifier(candidate.slice(0, MAX_IDENTIFIER_LENGTH - tag.length)) + tag;
  }
  used.add(name);
  return name;
}
