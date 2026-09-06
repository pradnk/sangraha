import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  max: z.number().int().min(2).max(10).default(5),
  /** `faces` renders smiley-to-frown icons, which needs no reading at all and
   *  is the right default for satisfaction and wellbeing questions. */
  display: z.enum(['stars', 'faces', 'numbers']).default('faces'),
  minLabel: z.record(z.string()).optional(),
  maxLabel: z.record(z.string()).optional(),
});

type Config = z.infer<typeof configSchema>;

export const ratingFieldType: FieldTypeDefinition<Config> = {
  type: 'rating',
  labelKey: 'fieldType.rating',
  icon: 'Star',
  configSchema,
  valueSchema: (field, config) => {
    const schema = z.number().int().min(1).max(config.max);
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    { suffix: '', pgType: 'bigint', expr: (ctx) => safeCast(jsonText(ctx), 'bigint') },
  ],
  toExportValue: exportAsString,
};
