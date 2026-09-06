import { and, asc, count, eq, max, sql } from 'drizzle-orm';
import type { I18nText } from '@sangraha/form-engine';
import { localise, toSnakeCase } from '@sangraha/form-engine';
import type { DbLike } from '../client';
import { formFields, optionSets, options } from '../schema/config';
import { submissions } from '../schema/data';

/**
 * Answer lists.
 *
 * Defining "Reason for absence" once and reusing it is what makes answers
 * comparable across forms and across years. That only holds if the `code` of
 * each option is immutable — it is the value stored in every submission and the
 * value that appears in analytics. Labels are presentation and change freely.
 */

export interface OptionSetDetail {
  id: string;
  code: string;
  name: I18nText;
  isShared: boolean;
  usedByFieldCount: number;
  options: {
    id: string;
    code: string;
    label: I18nText;
    sortOrder: number;
    isActive: boolean;
    /** Submissions already holding this code, across every form. */
    answerCount: number;
  }[];
}

export async function listOptionSets(db: DbLike, orgId: string): Promise<OptionSetDetail[]> {
  const sets = await db
    .select({
      id: optionSets.id,
      code: optionSets.code,
      name: optionSets.name,
      isShared: optionSets.isShared,
    })
    .from(optionSets)
    .where(eq(optionSets.orgId, orgId))
    .orderBy(asc(optionSets.code));

  if (sets.length === 0) return [];

  const rows = await db
    .select({
      id: options.id,
      optionSetId: options.optionSetId,
      code: options.code,
      label: options.label,
      sortOrder: options.sortOrder,
      isActive: options.isActive,
    })
    .from(options)
    .innerJoin(optionSets, eq(optionSets.id, options.optionSetId))
    .where(eq(optionSets.orgId, orgId))
    .orderBy(asc(options.sortOrder));

  // How many questions point at each list. Used to warn before an edit that
  // would ripple into live forms.
  const usage = await db
    .select({ optionSetId: formFields.optionSetId, total: count() })
    .from(formFields)
    .innerJoin(optionSets, eq(optionSets.id, formFields.optionSetId))
    .where(eq(optionSets.orgId, orgId))
    .groupBy(formFields.optionSetId);

  const usageBySet = new Map(usage.map((u) => [u.optionSetId, Number(u.total)]));

  return sets.map((set) => ({
    ...set,
    usedByFieldCount: usageBySet.get(set.id) ?? 0,
    options: rows
      .filter((o) => o.optionSetId === set.id)
      .map((o) => ({ ...o, answerCount: 0 })),
  }));
}

/**
 * Counts submissions holding a given option code.
 *
 * Deliberately searches across every form: the same list may be attached to
 * several questions, and retiring an option has to account for all of them.
 * Matches both a scalar answer and membership of a multi-select array.
 */
export async function countAnswersForOption(
  db: DbLike,
  orgId: string,
  optionSetId: string,
  code: string,
): Promise<number> {
  const keys = await db
    .select({ key: formFields.key })
    .from(formFields)
    .where(eq(formFields.optionSetId, optionSetId));

  const distinct = [...new Set(keys.map((k) => k.key))];
  if (distinct.length === 0) return 0;

  const [row] = await db
    .select({ total: count() })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, orgId),
        /*
         * Each key is its own bound parameter.
         *
         * `sql.join` rather than interpolating the array directly: Drizzle
         * spreads an array into separate placeholders, so `${keys}::text[]`
         * binds only the first element and Postgres rejects it as a malformed
         * array literal. Hand-escaping into `sql.raw` would have worked too,
         * and is the habit that eventually lets an injection through.
         */
        /*
         * Top level, and one level down inside a repeating section.
         *
         * A repeat group's answers are nested — data[groupKey] is an array of
         * objects with the child keys inside — so `data -> k` never saw them.
         * A single-choice question inside a repeating section therefore counted
         * zero uses, `deleteOptionAction` saw it as unused, and the option was
         * hard-deleted: every stored answer in that group left holding a code
         * with no label, which is the outcome this guard exists to prevent.
         */
        sql`EXISTS (
          SELECT 1 FROM unnest(ARRAY[${sql.join(
            distinct.map((key) => sql`${key}`),
            sql`, `,
          )}]::text[]) AS k
          WHERE ${submissions.data} -> k = to_jsonb(${code}::text)
             OR ${submissions.data} -> k @> to_jsonb(${code}::text)
             OR EXISTS (
               SELECT 1
               FROM jsonb_each(${submissions.data}) AS top(gk, gv)
               WHERE jsonb_typeof(gv) = 'array'
                 AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(gv) AS entry
                   WHERE jsonb_typeof(entry) = 'object'
                     AND (entry -> k = to_jsonb(${code}::text)
                          OR entry -> k @> to_jsonb(${code}::text))
                 )
             )
        )`,
      ),
    );

  return Number(row?.total ?? 0);
}

export async function createOptionSet(
  db: DbLike,
  orgId: string,
  name: I18nText,
): Promise<string> {
  const base = toSnakeCase(localise(name, 'en')).slice(0, 50) || 'list';

  const taken = new Set(
    (
      await db.select({ code: optionSets.code }).from(optionSets).where(eq(optionSets.orgId, orgId))
    ).map((s) => s.code),
  );
  let code = base;
  let suffix = 2;
  while (taken.has(code)) code = `${base}_${suffix++}`;

  const [created] = await db
    .insert(optionSets)
    .values({ orgId, code, name })
    .returning({ id: optionSets.id });

  return created!.id;
}

export async function renameOptionSet(db: DbLike, id: string, name: I18nText): Promise<void> {
  await db.update(optionSets).set({ name, updatedAt: new Date() }).where(eq(optionSets.id, id));
}

/**
 * Adds an option.
 *
 * The code is derived from the label once and then frozen. An admin never types
 * it, and renaming the option later leaves it alone — which is what keeps a
 * year-old answer comparable with today's.
 */
export async function addOption(
  db: DbLike,
  optionSetId: string,
  label: I18nText,
): Promise<string> {
  const base = toSnakeCase(localise(label, 'en')).slice(0, 40) || 'option';

  const existing = await db
    .select({ code: options.code, sortOrder: options.sortOrder })
    .from(options)
    .where(eq(options.optionSetId, optionSetId));

  const taken = new Set(existing.map((o) => o.code));
  let code = base;
  let suffix = 2;
  while (taken.has(code)) code = `${base}_${suffix++}`;

  const [last] = await db
    .select({ maxOrder: max(options.sortOrder) })
    .from(options)
    .where(eq(options.optionSetId, optionSetId));

  const [created] = await db
    .insert(options)
    .values({ optionSetId, code, label, sortOrder: (last?.maxOrder ?? -1) + 1 })
    .returning({ id: options.id });

  return created!.id;
}

/** Relabels an option. Its code, and therefore its analytics identity, is untouched. */
export async function updateOptionLabel(
  db: DbLike,
  optionId: string,
  label: I18nText,
): Promise<void> {
  await db.update(options).set({ label }).where(eq(options.id, optionId));
}

/**
 * Retires or restores an option.
 *
 * Retiring is the safe counterpart to deleting: field workers stop being offered
 * it, and every answer already recorded against it keeps its meaning.
 */
export async function setOptionActive(
  db: DbLike,
  optionId: string,
  isActive: boolean,
): Promise<void> {
  await db.update(options).set({ isActive }).where(eq(options.id, optionId));
}

export async function deleteOption(db: DbLike, optionId: string): Promise<void> {
  await db.delete(options).where(eq(options.id, optionId));
}

export async function reorderOptions(
  db: DbLike,
  optionSetId: string,
  orderedIds: string[],
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await db
      .update(options)
      .set({ sortOrder: index })
      .where(and(eq(options.id, id), eq(options.optionSetId, optionSetId)));
  }
}

export async function getOptionSet(
  db: DbLike,
  orgId: string,
  id: string,
): Promise<OptionSetDetail | null> {
  const all = await listOptionSets(db, orgId);
  return all.find((set) => set.id === id) ?? null;
}
