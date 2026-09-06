import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { exportAsString, jsonText } from './_helpers';
import { TEXT_FORMATS, checkTextFormat } from '../text-formats';

const configSchema = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().default(255),
  placeholder: z.record(z.string()).optional(),
  /** Offers the microphone button on the capture screen. On by default — it is
   *  the main accommodation for field workers who find typing slow. */
  allowVoiceInput: z.boolean().default(true),
  /**
   * What kind of text this question accepts.
   *
   * Here rather than as a family of separate field types, because an
   * organisation needs a format nobody anticipated about as often as it needs
   * a common one — and a state-specific ration card number should not require
   * a release. See `text-formats.ts`.
   */
  format: z.enum(TEXT_FORMATS).default('any'),
  /** The mask, when `format` is `pattern`. `A` is a letter, `9` a digit. */
  formatPattern: z.string().max(40).optional(),
});

type Config = z.infer<typeof configSchema>;

export const shortTextFieldType: FieldTypeDefinition<Config> = {
  type: 'short_text',
  labelKey: 'fieldType.shortText',
  icon: 'Type',
  configSchema,
  valueSchema: (field, config) => {
    let schema = z.string().trim().max(config.maxLength);
    if (config.minLength) schema = schema.min(config.minLength);

    // Applied after the length rules so an empty optional answer is not
    // reported as a badly formatted one.
    const formatted = schema.superRefine((value, ctx) => {
      if (value === '') return;
      const result = checkTextFormat(value, config.format, config.formatPattern);
      if (!result.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.messageKey! });
      }
    });

    return field.isRequired
      ? z.string().trim().min(Math.max(1, config.minLength ?? 1)).pipe(formatted)
      : formatted.optional();
  },
  analyticsColumns: () => [{ suffix: '', pgType: 'text', expr: jsonText }],
  toExportValue: exportAsString,
};
