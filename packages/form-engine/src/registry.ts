import type { z } from 'zod';
import type { FieldDataType, FieldDefinition } from './types';

/**
 * Context handed to a field type when it emits SQL for the analytics view.
 */
export interface SqlContext {
  /** SQL expression for the jsonb object holding this field's answers, e.g. `s.data`. */
  data: string;
  field: FieldDefinition;
  /** Escapes a value for safe inlining as a SQL string literal. */
  literal: (value: string) => string;
  /**
   * SQL expression for the row's own organisation, e.g. `s.org_id`.
   *
   * Supplied rather than hardcoded because the alias belongs to whichever view
   * builder is calling. A field type that reaches into another table needs it:
   * these views run with owner rights, so an unfiltered lookup would resolve a
   * stray uuid to another organisation's row.
   */
  submissionOrg: string;
}

/**
 * One column a field contributes to its form's analytics view.
 *
 * Most fields emit exactly one. A geopoint emits `_lat` and `_lon`; a choice
 * field emits the stable code plus a resolved `_label`. The suffix is appended
 * to the field key to name the column.
 */
export interface AnalyticsColumn {
  suffix: string;
  pgType: string;
  expr: (ctx: SqlContext) => string;
}

/**
 * The complete definition of a field type.
 *
 * This is the single extension point of the form engine. A new type is added by
 * creating one module that exports one of these and registering it in
 * `./field-types/index.ts` — the builder, capture UI, validator, API, CSV export
 * and view generator all pick it up with no further changes.
 */
export interface FieldTypeDefinition<TConfig = Record<string, unknown>> {
  type: FieldDataType;
  /** i18n key for the plain-language name shown in the builder ("Choose one answer"). */
  labelKey: string;
  /** Lucide icon name shown beside the type in the builder palette. */
  icon: string;
  /**
   * Validates the admin-supplied settings for this type.
   *
   * The input side is `unknown` because config arrives as raw jsonb from the
   * database and most schemas here use `.default()`, which makes the parsed
   * output deliberately wider than the accepted input.
   */
  configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>;
  /** Builds the runtime validator for a single answer, given the field's config. */
  valueSchema: (field: FieldDefinition, config: TConfig) => z.ZodTypeAny;
  /** Columns this field contributes to the analytics view. */
  analyticsColumns: (field: FieldDefinition, config: TConfig) => AnalyticsColumn[];
  /** Renders an answer for CSV/Excel export. */
  toExportValue: (value: unknown, field: FieldDefinition, locale: string) => string;
  /** True for `repeat_group`: holds child fields and becomes its own analytics view. */
  isContainer?: boolean;
  /** True when the admin must attach an option set. */
  usesOptions?: boolean;
  /** True when the stored answer is an array. */
  isMultiValue?: boolean;
  /** True when the answer is an attachment reference rather than an inline value. */
  isAttachment?: boolean;
  /**
   * True when the stored answer is the id of a registered subject.
   *
   * A flag rather than a `dataType === 'subject_ref'` check at each call site,
   * so display code stays out of the business of knowing type names — the same
   * reason `isAttachment` exists.
   */
  referencesSubject?: boolean;
}

const registry = new Map<FieldDataType, FieldTypeDefinition<never>>();

export function registerFieldType<TConfig>(definition: FieldTypeDefinition<TConfig>): void {
  if (registry.has(definition.type)) {
    throw new Error(`Field type "${definition.type}" is already registered`);
  }
  registry.set(definition.type, definition as unknown as FieldTypeDefinition<never>);
}

export function getFieldType(type: FieldDataType): FieldTypeDefinition<never> {
  const definition = registry.get(type);
  if (!definition) {
    throw new Error(`Unknown field type "${type}". Is its module imported in field-types/index?`);
  }
  return definition;
}

export function listFieldTypes(): FieldTypeDefinition<never>[] {
  return [...registry.values()];
}

/** Escapes a string for inlining as a Postgres literal. */
export function pgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Escapes an identifier for use as a column or view name. */
export function pgIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Whether "no two records may share this answer" is a sensible rule to offer.
 *
 * Derived from what the registry already knows rather than declared on each
 * field type, so adding a type does not mean remembering a second place —
 * which is the whole point of the one-module-per-type rule.
 *
 * Excluded, and why:
 *   - **containers** — a repeating section holds many answers, not one
 *   - **attachments** — two photos of the same thing are different bytes, and
 *     two identical uploads are not a data-quality problem worth refusing
 *   - **boolean** — there are two possible answers, so the form would accept
 *     exactly two records ever. Nobody means that.
 *   - **multi_choice** — the stored value is a list, compared as text, so
 *     picking the same answers in a different order would slip past. A rule
 *     that holds only sometimes is worse than no rule.
 */
export function canBeUnique(dataType: FieldDataType): boolean {
  if (dataType === 'boolean' || dataType === 'multi_choice') return false;
  const definition = getFieldType(dataType);
  return !definition.isContainer && !definition.isAttachment;
}
