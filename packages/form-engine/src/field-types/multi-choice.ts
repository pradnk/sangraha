import { z } from 'zod';
import { pgLiteral, type FieldTypeDefinition, type SqlContext } from '../registry';
import type { OptionDefinition } from '../types';
import { localise } from '../i18n';
import { jsonValue } from './_helpers';

/**
 * Above this many options the per-option boolean columns stop being a
 * convenience and start being an unreadable view, so only the `text[]` column
 * is emitted. Long option sets are better analysed by unnesting the array.
 */
const MAX_ONE_HOT_OPTIONS = 30;

const configSchema = z.object({
  display: z.enum(['buttons', 'checkboxes', 'images']).default('buttons'),
  minSelections: z.number().int().nonnegative().optional(),
  maxSelections: z.number().int().positive().optional(),
});

type Config = z.infer<typeof configSchema>;

function activeOneHotOptions(field: { optionSet?: { options: OptionDefinition[] } | null }) {
  const active = (field.optionSet?.options ?? []).filter((o) => o.isActive);
  return active.length <= MAX_ONE_HOT_OPTIONS ? active : [];
}

export const multiChoiceFieldType: FieldTypeDefinition<Config> = {
  type: 'multi_choice',
  labelKey: 'fieldType.multiChoice',
  icon: 'ListChecks',
  configSchema,
  usesOptions: true,
  isMultiValue: true,
  valueSchema: (field, config) => {
    let schema = z.array(z.string().min(1));
    if (config.minSelections) schema = schema.min(config.minSelections);
    if (config.maxSelections) schema = schema.max(config.maxSelections);
    return field.isRequired ? schema.min(Math.max(1, config.minSelections ?? 1)) : schema.default([]);
  },
  analyticsColumns: (field) => [
    // A real text[] rather than a comma-joined string, so `WHERE 'sc' = ANY(caste)`
    // works directly in BI tools without string parsing.
    {
      suffix: '',
      pgType: 'text[]',
      expr: (ctx) =>
        `CASE WHEN jsonb_typeof(${jsonValue(ctx)}) = 'array'` +
        ` THEN ARRAY(SELECT jsonb_array_elements_text(${jsonValue(ctx)}))` +
        ` ELSE NULL::text[] END`,
    },
    // Also emit a one-hot boolean per option. This is what makes multi-select
    // usable in a pivot table, which is how most program staff analyse it.
    ...activeOneHotOptions(field).map((o) => ({
      suffix: `_${o.code}`,
      pgType: 'boolean',
      expr: (ctx: SqlContext) =>
        `COALESCE(${jsonValue(ctx)} @> jsonb_build_array(${pgLiteral(o.code)}), false)`,
    })),
  ],
  toExportValue: (value, field, locale) => {
    if (!Array.isArray(value)) return '';
    return value
      .map((code) => {
        const option = field.optionSet?.options.find((o) => o.code === code);
        return option ? localise(option.label, locale, code) : String(code);
      })
      .join('; ');
  },
};
