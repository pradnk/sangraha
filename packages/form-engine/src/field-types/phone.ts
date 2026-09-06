import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  /** ISO-3166 alpha-2. Drives the expected digit count and the input mask. */
  defaultCountry: z.string().length(2).default('IN'),
  /** Digits expected after any country code. 10 for India. */
  nationalDigits: z.number().int().min(5).max(15).default(10),
});

type Config = z.infer<typeof configSchema>;

export const phoneFieldType: FieldTypeDefinition<Config> = {
  type: 'phone',
  labelKey: 'fieldType.phone',
  icon: 'Phone',
  configSchema,
  valueSchema: (field, config) => {
    // Stored as digits only. The capture UI strips spaces, dashes and a
    // leading +91 or 0 before it gets here, because field workers type numbers
    // in every format imaginable and rejecting them is worse than normalising.
    const schema = z
      .string()
      .regex(new RegExp(`^\\d{${config.nationalDigits}}$`), 'invalidPhone');
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [{ suffix: '', pgType: 'text', expr: jsonText }],
  toExportValue: exportAsString,
};
