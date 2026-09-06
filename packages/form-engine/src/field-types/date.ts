import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const configSchema = z.object({
  /** Relative bounds are stored rather than absolute dates so a form stays
   *  correct next year without the admin editing it. */
  minRelativeDays: z.number().int().optional(),
  maxRelativeDays: z.number().int().optional(),
  /** Offers a "Today" shortcut button on the capture screen. */
  showTodayShortcut: z.boolean().default(true),
});

type Config = z.infer<typeof configSchema>;

export const dateFieldType: FieldTypeDefinition<Config> = {
  type: 'date',
  labelKey: 'fieldType.date',
  icon: 'Calendar',
  configSchema,
  valueSchema: (field) => {
    const schema = z.string().regex(ISO_DATE, 'invalidDate');
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    { suffix: '', pgType: 'date', expr: (ctx) => safeCast(jsonText(ctx), 'date') },
  ],
  toExportValue: exportAsString,
};
