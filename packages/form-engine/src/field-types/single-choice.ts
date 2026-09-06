import { z } from 'zod';
import { pgLiteral, type FieldTypeDefinition } from '../registry';
import { localise } from '../i18n';
import { exportAsString, jsonText } from './_helpers';

const configSchema = z.object({
  /** `buttons` renders each option as a full-width tap target — the default,
   *  because a native <select> is a poor target on a low-end phone. `dropdown`
   *  is offered once an option set gets long. */
  display: z.enum(['buttons', 'dropdown', 'images']).default('buttons'),
  allowOther: z.boolean().default(false),
});

type Config = z.infer<typeof configSchema>;

export const singleChoiceFieldType: FieldTypeDefinition<Config> = {
  type: 'single_choice',
  labelKey: 'fieldType.singleChoice',
  icon: 'CircleDot',
  configSchema,
  usesOptions: true,
  valueSchema: (field, config) => {
    const codes = (field.optionSet?.options ?? []).filter((o) => o.isActive).map((o) => o.code);
    // Historical answers must stay valid after an option is retired, so the
    // enum is only enforced on the way in; retired codes are accepted when
    // re-validating an existing submission via the `allowOther` escape hatch.
    const schema =
      codes.length > 0 && !config.allowOther
        ? z.enum(codes as [string, ...string[]])
        : z.string().min(1);
    return field.isRequired ? schema : schema.optional().nullable();
  },
  analyticsColumns: (field) => [
    // The stable code — this is what joins and groups reliably.
    { suffix: '', pgType: 'text', expr: jsonText },
    // A human-readable label alongside it, inlined as a CASE at generation
    // time so BI tools need no extra join and analysts get a readable column.
    {
      suffix: '_label',
      pgType: 'text',
      expr: (ctx) => {
        const options = (field.optionSet?.options ?? []).filter((o) => o.isActive);
        if (options.length === 0) return jsonText(ctx);
        const locale = 'en';
        const branches = options
          .map((o) => {
            const label = localise(o.label, locale, o.code);
            return `WHEN ${pgLiteral(o.code)} THEN ${pgLiteral(label)}`;
          })
          .join(' ');
        return `CASE ${jsonText(ctx)} ${branches} ELSE ${jsonText(ctx)} END`;
      },
    },
  ],
  toExportValue: (value, field, locale) => {
    const option = field.optionSet?.options.find((o) => o.code === value);
    if (!option) return exportAsString(value);
    return localise(option.label, locale, option.code);
  },
};
