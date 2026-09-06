'use client';

import type { ComparisonOp, FieldDefinition, RuleNode } from '@sangraha/form-engine';
import { localise } from '@sangraha/form-engine';

/**
 * Skip logic, composed from dropdowns and read as a sentence:
 *
 *     Show this question  only if  [Was the student present?]  is  [Absent]
 *
 * Never a formula box. A programme manager should not have to learn an
 * expression syntax to say "only ask this when they were absent", and a free
 * text expression would also have to be parsed — which is how form builders
 * end up with code execution holes. The output is a closed JSON AST that
 * `evaluateRule` interprets.
 *
 * Only single-condition rules are offered here. The AST supports and/or/not,
 * and the capture UI evaluates them; combining conditions in the UI is a
 * follow-up once there is evidence organisations need it.
 */

const OPERATORS: { op: ComparisonOp; label: string; needsValue: boolean }[] = [
  { op: 'eq', label: 'is', needsValue: true },
  { op: 'neq', label: 'is not', needsValue: true },
  { op: 'gt', label: 'is more than', needsValue: true },
  { op: 'lt', label: 'is less than', needsValue: true },
  { op: 'contains', label: 'includes', needsValue: true },
  { op: 'is_not_empty', label: 'has been answered', needsValue: false },
  { op: 'is_empty', label: 'has not been answered', needsValue: false },
];

export function RuleEditor({
  field,
  earlierFields,
  locale,
  onChange,
}: {
  field: FieldDefinition;
  /** Only questions before this one — a rule cannot depend on a later answer. */
  earlierFields: FieldDefinition[];
  locale: string;
  onChange: (rule: RuleNode | null) => void;
}) {
  const rule = field.visibilityRule;
  const simple = rule && rule.op !== 'and' && rule.op !== 'or' && rule.op !== 'not' ? rule : null;

  const dependsOn = simple ? earlierFields.find((f) => f.key === simple.field) : undefined;
  const operator = OPERATORS.find((o) => o.op === simple?.op) ?? OPERATORS[0]!;

  if (earlierFields.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        Add a question above this one to be able to show or hide it based on an answer.
      </p>
    );
  }

  if (rule && !simple) {
    // A rule authored elsewhere (seed data, API) may combine conditions. Show
    // it rather than silently overwriting something the builder cannot express.
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-100 p-3">
        <p className="text-xs text-slate-600">
          This question uses a combined condition that cannot be edited here yet.
        </p>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-deny-700 hover:underline">
          Remove
        </button>
      </div>
    );
  }

  if (!simple) {
    return (
      <button
        type="button"
        onClick={() =>
          onChange({ op: 'eq', field: earlierFields[0]!.key, value: defaultValueFor(earlierFields[0]!) })
        }
        className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-left text-xs text-slate-600 hover:border-brand-400 hover:text-brand-700"
      >
        + Only show this question sometimes
      </button>
    );
  }

  const update = (patch: Partial<Extract<RuleNode, { field: string }>>) =>
    onChange({ ...simple, ...patch } as RuleNode);

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-brand-50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-600">Show this question only if</span>

        <select
          value={simple.field}
          onChange={(event) => {
            const next = earlierFields.find((f) => f.key === event.target.value)!;
            update({ field: next.key, value: defaultValueFor(next) });
          }}
          className="rounded border border-slate-300 bg-white px-2 py-1"
        >
          {earlierFields.map((f) => (
            <option key={f.key} value={f.key}>
              {localise(f.label, locale, f.key)}
            </option>
          ))}
        </select>

        <select
          value={simple.op}
          onChange={(event) => update({ op: event.target.value as ComparisonOp })}
          className="rounded border border-slate-300 bg-white px-2 py-1"
        >
          {OPERATORS.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>

        {operator.needsValue ? (
          <ValueInput field={dependsOn} value={simple.value} locale={locale} onChange={(value) => update({ value })} />
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => onChange(null)}
        className="self-start text-xs text-deny-700 hover:underline"
      >
        Always show this question
      </button>
    </div>
  );
}

/**
 * The answer side of the sentence.
 *
 * Typed to the question it depends on: a yes/no question offers two buttons'
 * worth of choice, a choice question offers its own options by label. Typing a
 * raw code here would be the single easiest way to author a rule that silently
 * never matches.
 */
function ValueInput({
  field,
  value,
  locale,
  onChange,
}: {
  field: FieldDefinition | undefined;
  value: unknown;
  locale: string;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field?.dataType === 'boolean') {
    return (
      <select
        value={String(value)}
        onChange={(event) => onChange(event.target.value === 'true')}
        className="rounded border border-slate-300 bg-white px-2 py-1"
      >
        <option value="true">{localise(field.config.trueLabel as never, locale, 'Yes')}</option>
        <option value="false">{localise(field.config.falseLabel as never, locale, 'No')}</option>
      </select>
    );
  }

  const options = field?.optionSet?.options.filter((o) => o.isActive) ?? [];
  if (options.length > 0) {
    return (
      <select
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1"
      >
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {localise(option.label, locale, option.code)}
          </option>
        ))}
      </select>
    );
  }

  const numeric = field?.dataType === 'number' || field?.dataType === 'integer' || field?.dataType === 'rating';

  return (
    <input
      type={numeric ? 'number' : 'text'}
      value={String(value ?? '')}
      onChange={(event) => onChange(numeric ? Number(event.target.value) : event.target.value)}
      className="w-40 rounded border border-slate-300 bg-white px-2 py-1"
    />
  );
}

function defaultValueFor(field: FieldDefinition): string | number | boolean {
  if (field.dataType === 'boolean') return true;
  const first = field.optionSet?.options.find((o) => o.isActive);
  if (first) return first.code;
  if (field.dataType === 'number' || field.dataType === 'integer' || field.dataType === 'rating') return 0;
  return '';
}
