import './field-types/index';

import { getFieldType } from './registry';
import { localise } from './i18n';
import { visibleFields } from './validation';
import type { FieldDefinition, FormVersionDefinition, SubmissionData } from './types';

/** One answer, ready to put on a screen or in a spreadsheet cell. */
export interface DisplayAnswer {
  key: string;
  label: string;
  /** Rendered through the field type, so a choice code becomes its label. */
  value: string;
  dataType: FieldDefinition['dataType'];
  /** True when the question was asked but left blank. */
  isEmpty: boolean;
  /** Populated for repeating groups: one entry per row. */
  entries?: DisplayAnswer[][];
  /**
   * The subject this answer points at, when it points at one.
   *
   * Set whether or not the name resolved, so a screen can offer the link even
   * where it has to fall back to showing the id.
   */
  subjectId?: string;
}

/**
 * Turns a subject id into that person's name, or null if it names nobody.
 *
 * Pure and synchronous by design: the form engine must not know how to reach a
 * database. Callers load the names they need in bulk first — `resolveRecordNames`
 * in `@sangraha/db` — and hand the finished lookup in.
 */
export type SubjectNameLookup = (id: string) => string | null;

/**
 * Turns stored answers into label/value pairs for display.
 *
 * Shared by the worker's submission detail, the supervisor review screen and
 * CSV export, so all three render a value identically — a choice always shows
 * its label rather than its code, a boolean always reads Yes/No.
 *
 * Only questions that were actually asked are returned: a field hidden by skip
 * logic is omitted rather than shown blank, so a reviewer is not left wondering
 * why a question has no answer.
 *
 * `resolveSubjectName` is optional and changes nothing when it is left out, so
 * the export keeps emitting the raw uuid it always has. Screens pass one and
 * show a name.
 */
export function formatAnswers(
  version: FormVersionDefinition,
  data: SubmissionData,
  locale = 'en',
  resolveSubjectName?: SubjectNameLookup,
): DisplayAnswer[] {
  const topLevel = version.fields.filter((f) => !f.parentGroupId);
  return formatLevel(topLevel, version.fields, data, locale, resolveSubjectName);
}

function formatLevel(
  fields: FieldDefinition[],
  allFields: FieldDefinition[],
  data: SubmissionData,
  locale: string,
  resolveSubjectName?: SubjectNameLookup,
): DisplayAnswer[] {
  const answers: DisplayAnswer[] = [];

  for (const field of visibleFields(fields, data)) {
    const definition = getFieldType(field.dataType);
    const raw = data[field.key];
    const label = localise(field.label, locale, field.key);

    if (definition.isContainer) {
      const children = allFields.filter((f) => f.parentGroupId === field.id);
      const rows = Array.isArray(raw) ? (raw as SubmissionData[]) : [];
      answers.push({
        key: field.key,
        label,
        value: `${rows.length}`,
        dataType: field.dataType,
        isEmpty: rows.length === 0,
        entries: rows.map((entry) =>
          formatLevel(children, allFields, entry, locale, resolveSubjectName),
        ),
      });
      continue;
    }

    const isEmpty =
      raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);

    const subjectId =
      definition.referencesSubject && typeof raw === 'string' && raw !== '' ? raw : undefined;

    answers.push({
      key: field.key,
      label,
      // A resolver that names nobody leaves the id showing. Better a uuid a
      // reader can copy than a confident name belonging to someone else.
      value: isEmpty
        ? ''
        : ((subjectId && resolveSubjectName?.(subjectId)) ??
          definition.toExportValue(raw, field, locale)),
      dataType: field.dataType,
      isEmpty,
      ...(subjectId ? { subjectId } : {}),
    });
  }

  return answers;
}

/**
 * A one-line summary for a list row.
 *
 * Takes the first two non-empty answers, skipping attachments — a row reading
 * "a1b2c3d4-…" tells a worker nothing about which record it is.
 */
export function summariseSubmission(
  version: FormVersionDefinition,
  data: SubmissionData,
  locale = 'en',
  maxParts = 2,
  resolveSubjectName?: SubjectNameLookup,
): string {
  const parts: string[] = [];

  for (const answer of formatAnswers(version, data, locale, resolveSubjectName)) {
    if (answer.isEmpty || answer.entries) continue;
    const definition = getFieldType(answer.dataType);
    if (definition.isAttachment) continue;
    parts.push(answer.value);
    if (parts.length >= maxParts) break;
  }

  return parts.join(' · ');
}

/** Column headers for a CSV export, in form order. */
export function exportHeaders(version: FormVersionDefinition, locale = 'en'): string[] {
  return version.fields
    .filter((f) => !f.parentGroupId && !getFieldType(f.dataType).isContainer)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((f) => localise(f.label, locale, f.key));
}

/** Formats a single answer, for callers that have one field rather than a form. */
export function formatValue(
  field: FieldDefinition,
  value: unknown,
  locale = 'en',
  resolveSubjectName?: SubjectNameLookup,
): string {
  const definition = getFieldType(field.dataType);

  if (definition.referencesSubject && typeof value === 'string' && value !== '') {
    const name = resolveSubjectName?.(value);
    if (name) return name;
  }

  return definition.toExportValue(value, field, locale);
}
