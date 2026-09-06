import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const ISO_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const configSchema = z.object({
  minuteStep: z.number().int().min(1).max(60).default(5),
});

type Config = z.infer<typeof configSchema>;

export const timeFieldType: FieldTypeDefinition<Config> = {
  type: 'time',
  labelKey: 'fieldType.time',
  icon: 'Clock',
  configSchema,
  valueSchema: (field) => {
    const schema = z.string().regex(ISO_TIME, 'invalidTime');
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    { suffix: '', pgType: 'time', expr: (ctx) => safeCast(jsonText(ctx), 'time') },
  ],
  toExportValue: exportAsString,
};
