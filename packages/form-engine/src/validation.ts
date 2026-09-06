// Side-effect import: guarantees the field type registry is populated even when
// this module is imported directly rather than through the package index.
// field-types/* only depend on ./registry, so this introduces no cycle.
import './field-types/index';

import { getFieldType } from './registry';
import { evaluateRule } from './rules';
import type { FieldDefinition, FormVersionDefinition, SubmissionData } from './types';

export interface ValidationError {
  /** Dotted path to the offending answer, e.g. `members[0].age`. */
  path: string;
  fieldKey: string;
  /** i18n key or raw message from the field type's schema. */
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /**
   * The answers as they should be persisted: unknown keys dropped, answers to
   * questions hidden by skip logic removed, values coerced to their field type.
   */
  data: SubmissionData;
}

/**
 * Parses a field's admin-supplied settings, applying the type's defaults.
 *
 * A config that fails validation means the builder wrote something the type no
 * longer accepts — a renamed setting, a preset from an older version. Keeping
 * the form usable rather than taking it offline is right; the way it was done
 * was not. It returned `{}`, and `{}` is *no* config, not the defaults: zod
 * only materialises a `.default()` from a parse that succeeded.
 *
 * So one unrecognised key on a phone question left `nationalDigits` undefined
 * and built `new RegExp('^\\d{undefined}$')`, which rejects `9876543210` and
 * accepts the literal `9{undefined}`. Every real phone number on that question
 * was refused and the worker could not save. The quieter half is worse: the
 * same path silently dropped `maxLength`, `min` and `max` enforcement on every
 * other type, with nothing to see.
 *
 * Three steps, narrowest first: take the whole thing if it parses, otherwise
 * drop only the keys the schema objected to and keep the rest, and failing that
 * fall back to the defaults — which is what the original comment promised.
 */
export function resolveFieldConfig(field: FieldDefinition): Record<string, unknown> {
  const definition = getFieldType(field.dataType);
  const supplied = (field.config ?? {}) as Record<string, unknown>;

  const parsed = definition.configSchema.safeParse(supplied);
  if (parsed.success) return parsed.data as Record<string, unknown>;

  // Only the settings the schema actually objected to. An admin's `maxSizeMb`
  // should not be discarded because a stale `legacyMode` sits beside it.
  const offending = new Set(
    parsed.error.issues
      .map((issue) => issue.path[0])
      .filter((key): key is string => typeof key === 'string'),
  );
  const kept = Object.fromEntries(
    Object.entries(supplied).filter(([key]) => !offending.has(key)),
  );
  const retried = definition.configSchema.safeParse(kept);
  if (retried.success) return retried.data as Record<string, unknown>;

  const defaults = definition.configSchema.safeParse({});
  return defaults.success ? (defaults.data as Record<string, unknown>) : {};
}

/** Fields the worker should actually see, given what they have answered so far. */
export function visibleFields(
  fields: FieldDefinition[],
  data: SubmissionData,
): FieldDefinition[] {
  return fields
    .filter((f) => !f.isArchived)
    .filter((f) => evaluateRule(f.visibilityRule, data))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Validates and normalises a submission against one form version.
 *
 * Used unchanged by the capture UI (per-question, as the worker advances), by
 * the REST API and by bulk import, so a value that is acceptable in one path is
 * acceptable in all of them.
 */
export function validateSubmission(
  version: FormVersionDefinition,
  input: SubmissionData,
): ValidationResult {
  const topLevel = version.fields.filter((f) => !f.parentGroupId);
  const errors: ValidationError[] = [];
  const data = validateLevel(topLevel, version.fields, input, '', errors);
  return { ok: errors.length === 0, errors, data };
}

function validateLevel(
  fields: FieldDefinition[],
  allFields: FieldDefinition[],
  input: SubmissionData,
  pathPrefix: string,
  errors: ValidationError[],
): SubmissionData {
  const output: SubmissionData = {};

  for (const field of visibleFields(fields, input)) {
    const definition = getFieldType(field.dataType);
    const config = resolveFieldConfig(field);
    const path = pathPrefix ? `${pathPrefix}.${field.key}` : field.key;
    const raw = input[field.key];

    if (definition.isContainer) {
      output[field.key] = validateRepeat(field, allFields, raw, path, errors);
      continue;
    }

    const parsed = definition.valueSchema(field, config as never).safeParse(coerce(raw, field));
    if (parsed.success) {
      if (parsed.data !== undefined) output[field.key] = parsed.data;
    } else {
      for (const issue of parsed.error.issues) {
        errors.push({ path, fieldKey: field.key, message: issue.message });
      }
    }
  }

  // Answers to questions that are currently hidden are intentionally absent
  // from `output`. If a worker answers "pregnant: yes", fills the follow-up,
  // then corrects it to "no", the orphaned follow-up answer must not be stored
  // — it would otherwise show up in analysis as a pregnancy that never was.
  return output;
}

function validateRepeat(
  group: FieldDefinition,
  allFields: FieldDefinition[],
  raw: unknown,
  path: string,
  errors: ValidationError[],
): unknown[] {
  const definition = getFieldType(group.dataType);
  const config = resolveFieldConfig(group);
  const shape = definition.valueSchema(group, config as never).safeParse(raw ?? []);

  if (!shape.success) {
    for (const issue of shape.error.issues) {
      errors.push({ path, fieldKey: group.key, message: issue.message });
    }
    return [];
  }

  const children = allFields.filter((f) => f.parentGroupId === group.id);
  const entries = (shape.data as Record<string, unknown>[]) ?? [];

  return entries.map((entry, index) =>
    validateLevel(children, allFields, entry, `${path}[${index}]`, errors),
  );
}

/**
 * Nudges browser-supplied values into the shape the field type expects.
 *
 * Every HTML input yields a string. Rather than making all nineteen field types
 * defensive about that, the numeric and boolean cases are normalised once here.
 */
function coerce(raw: unknown, field: FieldDefinition): unknown {
  if (raw === '' || raw === undefined) return undefined;

  switch (field.dataType) {
    case 'number':
    case 'integer':
    case 'rating':
    case 'calculated': {
      if (typeof raw !== 'string') return raw;
      const value = Number(raw);
      return Number.isNaN(value) ? raw : value;
    }
    case 'boolean': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return raw;
    }
    case 'multi_choice':
      // A single-item select posts a bare string; normalise to an array so the
      // stored shape never varies with how many boxes happened to be ticked.
      return Array.isArray(raw) ? raw : [raw];
    case 'phone':
      return typeof raw === 'string' ? normalisePhone(raw) : raw;
    default:
      return raw;
  }
}

/**
 * Strips formatting and any country/trunk prefix.
 *
 * Field workers type phone numbers as "+91 98765 43210", "098765-43210" and
 * "9876543210" interchangeably; rejecting the first two would be a support
 * burden with no upside, so they are normalised to bare national digits.
 */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}
