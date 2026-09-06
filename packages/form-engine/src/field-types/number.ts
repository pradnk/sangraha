import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  decimalPlaces: z.number().int().min(0).max(6).default(2),
  /** Shown after the input, e.g. "kg", "cm", "₹". */
  unit: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

export const numberFieldType: FieldTypeDefinition<Config> = {
  type: 'number',
  labelKey: 'fieldType.number',
  icon: 'Hash',
  configSchema,
  valueSchema: (field, config) => {
    let schema = z.number();
    if (config.min !== undefined) schema = schema.min(config.min);
    if (config.max !== undefined) schema = schema.max(config.max);
    return field.isRequired ? schema : schema.optional().nullable();
  },
  // Emitted as unconstrained `numeric`. Pinning the scale here would mean an
  // admin raising decimalPlaces silently truncates values already collected.
  analyticsColumns: () => [
    { suffix: '', pgType: 'numeric', expr: (ctx) => safeCast(jsonText(ctx), 'numeric') },
  ],
  toExportValue: exportAsString,
};
