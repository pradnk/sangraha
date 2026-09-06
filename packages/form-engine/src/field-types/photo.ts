import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  /** Applied in the browser before upload. Field workers are frequently on 2G,
   *  and an uncompressed 8MP photo is the difference between a submission that
   *  lands and one that times out. */
  maxWidthPx: z.number().int().min(320).max(4096).default(1280),
  compressionQuality: z.number().min(0.3).max(1).default(0.7),
  /** Opens the rear camera directly rather than the gallery picker. */
  preferCamera: z.boolean().default(true),
  maxCount: z.number().int().min(1).max(10).default(1),
});

type Config = z.infer<typeof configSchema>;

export const photoFieldType: FieldTypeDefinition<Config> = {
  type: 'photo',
  labelKey: 'fieldType.photo',
  icon: 'Camera',
  configSchema,
  isAttachment: true,
  // The answer is the attachment's uuid; file metadata lives in the
  // `attachments` table and is exposed as the `analytics.attachments` dimension.
  valueSchema: (field) => {
    const schema = z.string().uuid();
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    { suffix: '_attachment_id', pgType: 'uuid', expr: (ctx) => safeCast(jsonText(ctx), 'uuid') },
  ],
  toExportValue: exportAsString,
};
