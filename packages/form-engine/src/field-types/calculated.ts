import { z } from 'zod';
import type { FieldTypeDefinition } from '../registry';
import { safeCast, exportAsString, jsonText } from './_helpers';

/**
 * A closed arithmetic AST, built in the admin UI from dropdowns the same way
 * skip logic is. No expression parsing and no `eval`, so a form author cannot
 * inject executable code.
 */
export type CalcNode =
  | { op: 'field'; key: string }
  | { op: 'const'; value: number }
  | { op: 'add' | 'subtract' | 'multiply' | 'divide'; left: CalcNode; right: CalcNode }
  | { op: 'round'; value: CalcNode; decimals: number }
  | { op: 'age_years'; date: CalcNode | { op: 'field'; key: string } };

const calcNode: z.ZodType<CalcNode> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('field'), key: z.string() }),
    z.object({ op: z.literal('const'), value: z.number() }),
    z.object({
      op: z.enum(['add', 'subtract', 'multiply', 'divide']),
      left: calcNode,
      right: calcNode,
    }),
    z.object({ op: z.literal('round'), value: calcNode, decimals: z.number().int().min(0).max(6) }),
    z.object({ op: z.literal('age_years'), date: calcNode }),
  ]),
) as z.ZodType<CalcNode>;

const configSchema = z.object({
  formula: calcNode,
  resultType: z.enum(['number', 'integer']).default('number'),
  decimalPlaces: z.number().int().min(0).max(6).default(2),
  unit: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

/**
 * A read-only field computed from other answers — BMI, age from date of birth,
 * total household income.
 *
 * The value is evaluated in the capture UI and stored like any other answer, so
 * the analytics view stays a plain column and historical rows keep the value
 * that was actually shown to the worker even if the formula is later changed.
 */
export const calculatedFieldType: FieldTypeDefinition<Config> = {
  type: 'calculated',
  labelKey: 'fieldType.calculated',
  icon: 'Sigma',
  configSchema,
  // Never required: it cannot be filled by hand, so a missing input must not
  // block submission.
  valueSchema: () => z.number().optional().nullable(),
  analyticsColumns: (_field, config) => {
    const pgType = config.resultType === 'integer' ? ('bigint' as const) : ('numeric' as const);
    return [{ suffix: '', pgType, expr: (ctx) => safeCast(jsonText(ctx), pgType) }];
  },
  toExportValue: exportAsString,
};
