import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  maxLength: z.number().int().positive().default(4000),
  rows: z.number().int().min(2).max(12).default(4),
  placeholder: z.record(z.string()).optional(),
  allowVoiceInput: z.boolean().default(true),
});

type Config = z.infer<typeof configSchema>;

export const longTextFieldType: FieldTypeDefinition<Config> = {
  type: 'long_text',
  labelKey: 'fieldType.longText',
  icon: 'AlignLeft',
  configSchema,
  valueSchema: (field, config) => {
    const schema = z.string().trim().max(config.maxLength);
    return field.isRequired ? schema.min(1) : schema.optional();
  },
  analyticsColumns: () => [{ suffix: '', pgType: 'text', expr: jsonText }],
  toExportValue: exportAsString,
};
