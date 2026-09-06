import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  /** Shown above the canvas, e.g. "Beneficiary's signature or thumb impression".
   *  Consent capture is a common donor requirement. */
  prompt: z.record(z.string()).optional(),
});

type Config = z.infer<typeof configSchema>;

export const signatureFieldType: FieldTypeDefinition<Config> = {
  type: 'signature',
  labelKey: 'fieldType.signature',
  icon: 'PenLine',
  configSchema,
  isAttachment: true,
  valueSchema: (field) => {
    const schema = z.string().uuid();
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: () => [
    { suffix: '_attachment_id', pgType: 'uuid', expr: (ctx) => safeCast(jsonText(ctx), 'uuid') },
    // A plain "was this signed?" boolean, which is what a compliance report
    // actually needs — nobody aggregates signature images.
    {
      suffix: '_signed',
      pgType: 'boolean',
      expr: (ctx) => `(${jsonText(ctx)} IS NOT NULL)`,
    },
  ],
  toExportValue: exportAsString,
};
