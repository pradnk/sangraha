import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, jsonText } from './_helpers';

const configSchema = z.object({
  /** Overrides for the two buttons. Defaults are the translated Yes / No. */
  trueLabel: z.record(z.string()).optional(),
  falseLabel: z.record(z.string()).optional(),
});

type Config = z.infer<typeof configSchema>;

export const booleanFieldType: FieldTypeDefinition<Config> = {
  type: 'boolean',
  labelKey: 'fieldType.boolean',
  icon: 'ToggleLeft',
  configSchema,
  valueSchema: (field) => (field.isRequired ? z.boolean() : z.boolean().optional().nullable()),
  analyticsColumns: () => [
    { suffix: '', pgType: 'boolean', expr: (ctx) => safeCast(jsonText(ctx), 'boolean') },
  ],
  // Exported as Yes/No rather than true/false — these files are read by
  // program staff in Excel far more often than by machines.
  toExportValue: (value) => (value === null || value === undefined ? '' : value ? 'Yes' : 'No'),
};
