import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  /** Restricts the picker to one subject type, e.g. only Schools. */
  subjectTypeId: z.string().uuid().optional(),
  /** Limits results to the worker's assigned locations. On by default — a
   *  village worker searching the whole state finds the wrong Sunita. */
  restrictToUserLocations: z.boolean().default(true),
});

type Config = z.infer<typeof configSchema>;

/**
 * A pointer to another registered subject — a student's school, a woman's SHG,
 * a child's household. This is what turns a pile of forms into a graph that can
 * answer questions across program areas.
 */
export const subjectRefFieldType: FieldTypeDefinition<Config> = {
  type: 'subject_ref',
  labelKey: 'fieldType.subjectRef',
  icon: 'Link2',
  configSchema,
  valueSchema: (field) => {
    const schema = z.string().uuid();
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    // Emitted as a real uuid so it joins straight to `analytics.subjects`.
    { suffix: '', pgType: 'uuid', expr: (ctx) => safeCast(jsonText(ctx), 'uuid') },
    /*
     * The name beside the id, so a funder-facing CSV does not carry a bare
     * uuid where a person belongs.
     *
     * A correlated subquery rather than a `CASE` inlined at generation time,
     * which is how `single_choice` does its `_label`. A choice has a handful of
     * options that only change on republish; a registry has thousands of people
     * and they get renamed. So this reads the name as it is *now*, and the two
     * columns deliberately do not behave the same way after a rename.
     *
     * Every identifier inside is qualified. An unqualified column in a
     * correlated subquery binds to the inner table and matches nothing —
     * silently, with no error and no rows, which is the hazard recorded in
     * CLAUDE.md.
     *
     * The `org_id` predicate is the tenant boundary, not an optimisation: these
     * views run with owner rights, so a stale or cross-tenant uuid sitting in a
     * jsonb answer would otherwise print another organisation's beneficiary's
     * name into this one's export.
     */
    {
      suffix: '_name',
      pgType: 'text',
      expr: (ctx) =>
        `(SELECT sref.display_name FROM public.subjects sref` +
        ` WHERE sref.id = ${safeCast(jsonText(ctx), 'uuid')}` +
        ` AND sref.org_id = ${ctx.submissionOrg})`,
    },
  ],
  /*
   * A bare uuid, because the export has no way to look a name up. Screens pass
   * a resolver to `formatAnswers` and get the person's name instead; see
   * `display.ts`.
   */
  toExportValue: exportAsString,
  referencesSubject: true,
};
