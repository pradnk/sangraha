import { resolveRecordNames, type DbLike } from '@sangraha/db';
import {
  getFieldType,
  type FormVersionDefinition,
  type SubjectNameLookup,
  type SubmissionData,
} from '@sangraha/form-engine';

/**
 * Names for the people a set of records point at.
 *
 * A `subject_ref` answer stores a uuid, so without this a record reads
 * "Guardian: b8b9cf9f-…" — the registry sitting one unusable line away from the
 * record that refers to it. Screens hand the finished lookup to `formatAnswers`
 * and get names instead.
 *
 * Collected across every record on the screen and resolved in one query, not
 * one per answer: a person's timeline can be dozens of entries deep.
 *
 * Returns `null` for an id that names nobody, which is what makes `formatAnswers`
 * fall back to showing the uuid rather than inventing a name.
 */
export async function subjectNameLookup(
  db: DbLike,
  orgId: string,
  records: { version: FormVersionDefinition | undefined; data: SubmissionData }[],
): Promise<SubjectNameLookup> {
  const ids: string[] = [];

  for (const { version, data } of records) {
    if (!version) continue;
    for (const field of version.fields) {
      if (!getFieldType(field.dataType).referencesSubject) continue;
      collect(data, field.key, ids);
    }
  }

  const names = await resolveRecordNames(db, orgId, {
    subjectIds: ids,
    userIds: [],
    locationIds: [],
  });

  return (id) => names.subject(id)?.displayName ?? null;
}

/**
 * Pulls a field's answer out, looking inside repeating groups too.
 *
 * A repeat group stores an array of objects rather than a value, and a
 * `subject_ref` inside one is exactly the case that would otherwise render as a
 * uuid on the one screen where a group is visible at all.
 */
function collect(data: SubmissionData, key: string, into: string[]): void {
  const value = data[key];
  if (typeof value === 'string' && value !== '') into.push(value);

  for (const entry of Object.values(data)) {
    if (!Array.isArray(entry)) continue;
    for (const row of entry) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        collect(row as SubmissionData, key, into);
      }
    }
  }
}
