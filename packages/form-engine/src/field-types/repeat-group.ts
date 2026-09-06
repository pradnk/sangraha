import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';

const configSchema = z.object({
  minEntries: z.number().int().nonnegative().default(0),
  maxEntries: z.number().int().positive().default(50),
  /** Button text, e.g. "Add another family member". Phrasing the action in the
   *  admin's own words is what makes the repeat obvious to a field worker. */
  addLabel: z.record(z.string()).optional(),
  /** Field keys used to title each saved entry in the list ("Ramesh, 12"). */
  summaryFieldKeys: z.array(z.string()).default([]),
});

type Config = z.infer<typeof configSchema>;

/**
 * A repeating section: "add another household member", "add another crop".
 *
 * Answers are stored as an array of sub-records under the group's key. It emits
 * no columns on the parent view — instead the generator gives it a child view,
 * `analytics.<form>__<group_key>`, with a foreign key back to the parent
 * submission. That is what keeps the analytics output relational rather than
 * nested.
 */
export const repeatGroupFieldType: FieldTypeDefinition<Config> = {
  type: 'repeat_group',
  labelKey: 'fieldType.repeatGroup',
  icon: 'Repeat',
  configSchema,
  isContainer: true,
  isMultiValue: true,
  // Child entries are validated by the generated schema walker, which composes
  // each nested field's own validator; this only guards the array shape.
  valueSchema: (_field, config) =>
    z.array(z.record(z.unknown())).min(config.minEntries).max(config.maxEntries).default([]),
  analyticsColumns: () => [],
  toExportValue: (value) => (Array.isArray(value) ? `${value.length} entries` : ''),
};
