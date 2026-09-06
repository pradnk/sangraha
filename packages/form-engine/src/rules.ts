import { z } from 'zod';
import type { ComparisonOp, RuleNode, RuleValue, SubmissionData } from './types';

/**
 * Evaluates a skip-logic rule against the answers filled so far.
 *
 * The AST is closed and interpreted here — there is no expression parser and no
 * `eval`, so a form author (or anyone who can reach the form-builder API)
 * cannot get code execution through a visibility rule.
 *
 * Unknown fields evaluate as empty rather than throwing: a rule may legitimately
 * reference a question the worker has not reached yet.
 */
export function evaluateRule(rule: RuleNode | null | undefined, data: SubmissionData): boolean {
  if (!rule) return true;

  switch (rule.op) {
    case 'and':
      return rule.rules.every((r) => evaluateRule(r, data));
    case 'or':
      return rule.rules.some((r) => evaluateRule(r, data));
    case 'not':
      return !evaluateRule(rule.rule, data);
    default:
      return compare(rule.op, data[rule.field], rule.value);
  }
}

function compare(op: ComparisonOp, actual: unknown, expected: RuleValue): boolean {
  switch (op) {
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'eq':
      return looseEquals(actual, expected);
    case 'neq':
      return !looseEquals(actual, expected);
    case 'in':
      return Array.isArray(expected) && expected.some((v) => looseEquals(actual, v));
    case 'not_in':
      return Array.isArray(expected) && !expected.some((v) => looseEquals(actual, v));
    case 'contains':
      // Works for multi-select answers and for substring matching on text.
      if (Array.isArray(actual)) return actual.some((v) => looseEquals(v, expected));
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.toLowerCase().includes(expected.toLowerCase())
        : false;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareOrdered(op, actual, expected);
    default: {
      const exhaustive: never = op;
      throw new Error(`Unsupported rule operator: ${String(exhaustive)}`);
    }
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Compares across the string/number boundary.
 *
 * Answers arrive from HTML inputs as strings while rule values are authored in
 * the builder as typed JSON, so `"3" === 3` has to hold for a rule on a numeric
 * question to work at all.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  if (typeof a === 'number' || typeof b === 'number') {
    /*
     * An unanswered question is not a zero.
     *
     * `Number('')` is 0, so a rule reading "show this when *Number of children*
     * is 0" also fired on every form where the question had not been answered
     * yet — which, one question per screen, is every form until the worker gets
     * there. The follow-up question appeared, then disappeared as they typed.
     * `isEmpty` rather than a bare `=== ''` so `[]` is caught the same way.
     */
    if (isEmpty(a) || isEmpty(b)) return false;
    const na = Number(a);
    const nb = Number(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
  }
  return String(a) === String(b);
}

function compareOrdered(op: 'gt' | 'gte' | 'lt' | 'lte', actual: unknown, expected: RuleValue): boolean {
  if (isEmpty(actual) || expected === null || Array.isArray(expected)) return false;

  const a = Number(actual);
  const b = Number(expected);
  // Falls back to lexicographic comparison, which is what makes ISO dates
  // ("2026-08-05") order correctly without any date parsing.
  const [left, right]: [number, number] | [string, string] =
    Number.isNaN(a) || Number.isNaN(b) ? [String(actual), String(expected)] : [a, b];

  switch (op) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}

/** Field keys a rule depends on — used to recompute visibility only when needed. */
export function ruleDependencies(rule: RuleNode | null | undefined, into = new Set<string>()): Set<string> {
  if (!rule) return into;
  if (rule.op === 'and' || rule.op === 'or') {
    rule.rules.forEach((r) => ruleDependencies(r, into));
  } else if (rule.op === 'not') {
    ruleDependencies(rule.rule, into);
  } else {
    into.add(rule.field);
  }
  return into;
}

/**
 * The same rule, with one dependency renamed.
 *
 * A rule names the question it depends on by `key`, and a provisional key is
 * re-derived the first time an admin gives the question a real label — so
 * `untitled_question_2` becomes `guardian_phone` and every rule pointing at the
 * old name silently stops matching. `evaluateRule` sees `undefined`,
 * `visibleFields` drops the dependent question from the form *and* from
 * validation, and a required question disappears for every field worker with
 * nothing to show it went.
 *
 * Returns the rule unchanged when nothing referenced the old key, so a caller
 * can use the identity of the result to decide whether a write is needed.
 */
export function renameRuleDependency(
  rule: RuleNode | null | undefined,
  from: string,
  to: string,
): RuleNode | null {
  if (!rule) return null;

  if (rule.op === 'and' || rule.op === 'or') {
    const rules = rule.rules.map((r) => renameRuleDependency(r, from, to) ?? r);
    return rules.some((r, i) => r !== rule.rules[i]) ? { ...rule, rules } : rule;
  }
  if (rule.op === 'not') {
    const inner = renameRuleDependency(rule.rule, from, to);
    return inner && inner !== rule.rule ? { ...rule, rule: inner } : rule;
  }
  return rule.field === from ? { ...rule, field: to } : rule;
}

/**
 * Runtime schema for a visibility rule.
 *
 * The builder posts rules from the browser, so this is a trust boundary: it is
 * what stops an arbitrary JSON blob being stored where `evaluateRule` expects a
 * closed AST. Defined here, next to the interpreter, so the two cannot drift.
 */
export const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('and'), rules: z.array(ruleNodeSchema) }),
    z.object({ op: z.literal('or'), rules: z.array(ruleNodeSchema) }),
    z.object({ op: z.literal('not'), rule: ruleNodeSchema }),
    z.object({
      op: z.enum([
        'eq',
        'neq',
        'gt',
        'gte',
        'lt',
        'lte',
        'in',
        'not_in',
        'contains',
        'is_empty',
        'is_not_empty',
      ]),
      field: z.string().min(1).max(120),
      value: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.union([z.string(), z.number()])),
      ]),
    }),
  ]),
) as z.ZodType<RuleNode>;
