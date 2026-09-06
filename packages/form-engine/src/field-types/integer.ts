import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  unit: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

export const integerFieldType: FieldTypeDefinition<Config> = {
  type: 'integer',
  labelKey: 'fieldType.integer',
  icon: 'Binary',
  configSchema,
  valueSchema: (field, config) => {
    let schema = z.number().int();
    if (config.min !== undefined) schema = schema.min(config.min);
    if (config.max !== undefined) schema = schema.max(config.max);
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    { suffix: '', pgType: 'bigint', expr: (ctx) => safeCast(jsonText(ctx), 'bigint') },
  ],
  toExportValue: exportAsString,
};
