import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  acceptedMimeTypes: z.array(z.string()).default(['application/pdf', 'image/*']),
  maxSizeMb: z.number().min(0.1).max(50).default(10),
});

type Config = z.infer<typeof configSchema>;

export const fileFieldType: FieldTypeDefinition<Config> = {
  type: 'file',
  labelKey: 'fieldType.file',
  icon: 'Paperclip',
  configSchema,
  isAttachment: true,
  valueSchema: (field) => {
    const schema = z.string().uuid();
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    { suffix: '_attachment_id', pgType: 'uuid', expr: (ctx) => safeCast(jsonText(ctx), 'uuid') },
  ],
  toExportValue: exportAsString,
};
