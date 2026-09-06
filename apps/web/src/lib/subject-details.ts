import { and, eq, inArray } from 'drizzle-orm';
import { listRegistrationFields, subjectTypes, type DbLike } from '@sangraha/db';
import { formatValue, localise, type SubmissionData } from '@sangraha/form-engine';

/**
 * The few answers that tell one person from another.
 *
 * Every screen that asks a worker to choose a person needs these, and they all
 * need the same ones in the same order — a list of bare names is not something
 * anybody can choose from when two people share one. Shared between the search
 * endpoint and the duplicate check so the two cannot disagree about what
 * identifies somebody.
 */

export interface SubjectDetailLine {
  key: string;
  label: string;
  value: string;
}

export interface DetailResolver {
  (subjectTypeId: string, attributes: SubmissionData): SubjectDetailLine[];
}

/** How many lines a card shows. A phone screen, and a wall of text is unreadable. */
const MAX_LINES = 4;

/**
 * Builds a resolver for the subject types present in a result set.
 *
 * Loads each type's registration fields once rather than per row — a search
 * returning 25 people would otherwise issue 25 identical queries.
 */
export async function subjectDetailResolver(
  db: DbLike,
  orgId: string,
  subjectTypeIds: string[],
  locale: string,
): Promise<DetailResolver> {
  const unique = [...new Set(subjectTypeIds)];
  if (unique.length === 0) return () => [];

  /*
   * The answers that compose the display name are skipped: they are already
   * the heading. Repeating them wastes the two or three lines a phone card has
   * — "Name: Test1" under a heading reading "Test1" tells nobody anything.
   */
  const nameFields = new Map(
    (
      await db
        .select({ id: subjectTypes.id, displayNameFields: subjectTypes.displayNameFields })
        .from(subjectTypes)
        .where(and(eq(subjectTypes.orgId, orgId), inArray(subjectTypes.id, unique)))
    ).map((type) => [type.id, new Set(type.displayNameFields)]),
  );

  const perType = new Map<
    string,
    { order: string[]; fields: Map<string, { label: string; dataType: string }> }
  >();

  for (const subjectTypeId of unique) {
    const fields = await listRegistrationFields(db, orgId, subjectTypeId);
    const named = nameFields.get(subjectTypeId) ?? new Set<string>();

    perType.set(subjectTypeId, {
      // Form order. The organisation put the identifying questions where it
      // wanted them; second-guessing that produces a different order on every
      // screen.
      order: fields.map((field) => field.key).filter((key) => !named.has(key)),
      fields: new Map(
        fields.map((field) => [
          field.key,
          { label: localise(field.label, locale, field.key), dataType: field.dataType },
        ]),
      ),
    });
  }

  return (subjectTypeId, attributes) => {
    const type = perType.get(subjectTypeId);
    if (!type) return [];

    const lines: SubjectDetailLine[] = [];

    for (const key of type.order) {
      if (lines.length >= MAX_LINES) break;

      const field = type.fields.get(key);
      const value = attributes[key];
      if (!field || value === null || value === undefined || value === '') continue;

      lines.push({
        key,
        label: field.label,
        // Through the engine, so a choice shows its label and a date shows as
        // a date rather than as raw stored JSON.
        value: formatValue(
          { key, dataType: field.dataType, label: { en: field.label } } as never,
          value,
          locale,
        ),
      });
    }

    return lines;
  };
}

/**
 * Puts the answers an organisation nominated as identifying first.
 *
 * Used by the duplicate check, where the whole question is "are these two the
 * same person?" and a matching phone number is the strongest evidence there is.
 */
export function prioritise(
  lines: SubjectDetailLine[],
  first: string[],
): SubjectDetailLine[] {
  const rank = (line: SubjectDetailLine) => {
    const index = first.indexOf(line.key);
    return index === -1 ? first.length : index;
  };
  return [...lines].sort((a, b) => rank(a) - rank(b));
}
