import { describe, expect, it } from 'vitest';
import { evaluateRule, renameRuleDependency, ruleDependencies } from '../rules';
import type { RuleNode } from '../types';

describe('evaluateRule', () => {
  it('shows a field when its condition matches', () => {
    const rule: RuleNode = { op: 'eq', field: 'present', value: false };
    expect(evaluateRule(rule, { present: false })).toBe(true);
    expect(evaluateRule(rule, { present: true })).toBe(false);
  });

  it('treats an unanswered dependency as not matching rather than throwing', () => {
    // A rule routinely references a question the worker has not reached yet.
    const rule: RuleNode = { op: 'eq', field: 'pregnant', value: 'yes' };
    expect(evaluateRule(rule, {})).toBe(false);
    expect(evaluateRule({ op: 'is_empty', field: 'pregnant', value: null }, {})).toBe(true);
  });

  it('does not treat a blank answer as zero', () => {
    /*
     * `Number('')` is 0, so "show this when *Number of children* is 0" fired on
     * a form where the question had not been answered yet — which, one question
     * per screen, is every form until the worker reaches it. The follow-up
     * appeared and then vanished as they typed, which reads as the app losing
     * their place rather than as skip logic working.
     */
    const rule: RuleNode = { op: 'eq', field: 'children', value: 0 };
    expect(evaluateRule(rule, {})).toBe(false);
    expect(evaluateRule(rule, { children: '' })).toBe(false);
    expect(evaluateRule(rule, { children: null })).toBe(false);
    expect(evaluateRule(rule, { children: [] })).toBe(false);

    // A real zero still matches, in either notation. That is the whole point of
    // the rule and the reason this cannot be fixed by refusing the comparison.
    expect(evaluateRule(rule, { children: 0 })).toBe(true);
    expect(evaluateRule(rule, { children: '0' })).toBe(true);
  });

  it('compares across the string/number boundary', () => {
    // HTML inputs yield strings; builder values are typed JSON.
    expect(evaluateRule({ op: 'eq', field: 'age', value: 3 }, { age: '3' })).toBe(true);
    expect(evaluateRule({ op: 'gte', field: 'age', value: 18 }, { age: '18' })).toBe(true);
    expect(evaluateRule({ op: 'lt', field: 'age', value: 18 }, { age: '17' })).toBe(true);
  });

  it('orders ISO dates lexicographically without date parsing', () => {
    const rule: RuleNode = { op: 'gt', field: 'visit_date', value: '2026-01-31' };
    expect(evaluateRule(rule, { visit_date: '2026-02-01' })).toBe(true);
    expect(evaluateRule(rule, { visit_date: '2025-12-31' })).toBe(false);
  });

  it('matches a selected code inside a multi-choice answer', () => {
    const rule: RuleNode = { op: 'contains', field: 'services', value: 'anc' };
    expect(evaluateRule(rule, { services: ['imm', 'anc'] })).toBe(true);
    expect(evaluateRule(rule, { services: ['imm'] })).toBe(false);
  });

  it('composes and / or / not', () => {
    const rule: RuleNode = {
      op: 'and',
      rules: [
        { op: 'eq', field: 'gender', value: 'f' },
        { op: 'not', rule: { op: 'lt', field: 'age', value: 15 } },
      ],
    };
    expect(evaluateRule(rule, { gender: 'f', age: 20 })).toBe(true);
    expect(evaluateRule(rule, { gender: 'f', age: 12 })).toBe(false);
    expect(evaluateRule(rule, { gender: 'm', age: 20 })).toBe(false);
  });

  it('defaults to visible when a field has no rule', () => {
    expect(evaluateRule(null, {})).toBe(true);
  });

  it('collects the keys a rule depends on', () => {
    const rule: RuleNode = {
      op: 'or',
      rules: [
        { op: 'eq', field: 'a', value: 1 },
        { op: 'not', rule: { op: 'eq', field: 'b', value: 2 } },
      ],
    };
    expect([...ruleDependencies(rule)].sort()).toEqual(['a', 'b']);
  });
});

describe('renameRuleDependency', () => {
  /*
   * A provisional key is re-derived the first time a question gets a real
   * label — `untitled_question_2` becomes `guardian_phone` — and rules name
   * their dependency by key. Nothing followed the rename, so the dependent
   * question was hidden from every field worker permanently: `evaluateRule` saw
   * `undefined`, and `visibleFields` dropped it from the form *and* from
   * validation, so a required question simply vanished rather than blocking.
   */
  it('repoints a simple condition', () => {
    const rule: RuleNode = { op: 'eq', field: 'untitled_question_2', value: 'yes' };
    const renamed = renameRuleDependency(rule, 'untitled_question_2', 'guardian_phone');

    expect(renamed).toEqual({ op: 'eq', field: 'guardian_phone', value: 'yes' });
    // And it still fires, which is the whole point.
    expect(evaluateRule(renamed, { guardian_phone: 'yes' })).toBe(true);
  });

  it('reaches inside and, or and not', () => {
    const rule: RuleNode = {
      op: 'and',
      rules: [
        { op: 'eq', field: 'old', value: 1 },
        { op: 'not', rule: { op: 'eq', field: 'old', value: 2 } },
        { op: 'or', rules: [{ op: 'eq', field: 'other', value: 3 }] },
      ],
    };

    const renamed = renameRuleDependency(rule, 'old', 'new');

    expect([...ruleDependencies(renamed)].sort()).toEqual(['new', 'other']);
  });

  it('returns the rule unchanged when nothing referenced the old key', () => {
    // Identity, so a caller can skip the write entirely.
    const rule: RuleNode = { op: 'eq', field: 'other', value: 1 };
    expect(renameRuleDependency(rule, 'old', 'new')).toBe(rule);
  });

  it('handles no rule at all', () => {
    expect(renameRuleDependency(null, 'old', 'new')).toBeNull();
  });
});
