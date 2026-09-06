import { describe, expect, it } from 'vitest';
import { resolveFieldConfig, validateSubmission } from '../validation';
import { field, optionSet, version } from './fixtures';

describe('validateSubmission', () => {
  it('accepts a well-formed submission and coerces string inputs', () => {
    const form = version(1, [
      field('student_name', 'short_text', { isRequired: true }),
      field('age', 'integer'),
      field('present', 'boolean'),
    ]);

    const result = validateSubmission(form, {
      student_name: 'Sunita Devi',
      age: '12',
      present: 'true',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ student_name: 'Sunita Devi', age: 12, present: true });
  });

  it('reports a missing required answer against its field key', () => {
    const form = version(1, [field('student_name', 'short_text', { isRequired: true })]);
    const result = validateSubmission(form, {});

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.fieldKey).toBe('student_name');
  });

  it('drops answers to questions hidden by skip logic', () => {
    // The scenario this guards: a worker answers "absent", fills in a reason,
    // then corrects the answer to "present". The orphaned reason must not be
    // stored, or it shows up in analysis as an absence that never happened.
    const form = version(1, [
      field('present', 'boolean', { isRequired: true }),
      field('absence_reason', 'short_text', {
        visibilityRule: { op: 'eq', field: 'present', value: false },
      }),
    ]);

    const result = validateSubmission(form, { present: true, absence_reason: 'illness' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ present: true });
    expect(result.data).not.toHaveProperty('absence_reason');
  });

  it('keeps the answer when skip logic makes the question visible', () => {
    const form = version(1, [
      field('present', 'boolean', { isRequired: true }),
      field('absence_reason', 'short_text', {
        visibilityRule: { op: 'eq', field: 'present', value: false },
      }),
    ]);

    const result = validateSubmission(form, { present: false, absence_reason: 'illness' });

    expect(result.data).toEqual({ present: false, absence_reason: 'illness' });
  });

  it('does not enforce required on a hidden question', () => {
    const form = version(1, [
      field('present', 'boolean', { isRequired: true }),
      field('absence_reason', 'short_text', {
        isRequired: true,
        visibilityRule: { op: 'eq', field: 'present', value: false },
      }),
    ]);

    expect(validateSubmission(form, { present: true }).ok).toBe(true);
  });

  it('discards keys that are not part of the form', () => {
    const form = version(1, [field('student_name', 'short_text')]);
    const result = validateSubmission(form, { student_name: 'A', injected: 'junk' });

    expect(result.data).not.toHaveProperty('injected');
  });

  it('normalises phone numbers however the worker typed them', () => {
    const form = version(1, [field('mobile', 'phone', { isRequired: true })]);

    for (const input of ['+91 98765 43210', '098765-43210', '9876543210']) {
      const result = validateSubmission(form, { mobile: input });
      expect(result.ok, `${input} should be accepted`).toBe(true);
      expect(result.data.mobile).toBe('9876543210');
    }
  });

  it('rejects a choice code that is not in the option set', () => {
    const form = version(1, [
      field('grade', 'single_choice', { isRequired: true, optionSet: optionSet('grades', ['g1', 'g2']) }),
    ]);

    expect(validateSubmission(form, { grade: 'g1' }).ok).toBe(true);
    expect(validateSubmission(form, { grade: 'g9' }).ok).toBe(false);
  });

  it('wraps a single multi-choice selection into an array', () => {
    const form = version(1, [
      field('services', 'multi_choice', { optionSet: optionSet('svc', ['anc', 'imm']) }),
    ]);

    expect(validateSubmission(form, { services: 'anc' }).data.services).toEqual(['anc']);
  });

  it('validates each entry of a repeating group and paths the errors', () => {
    const group = field('members', 'repeat_group', { id: 'grp-members' });
    const form = version(1, [
      group,
      field('member_name', 'short_text', { isRequired: true, parentGroupId: 'grp-members' }),
      field('member_age', 'integer', { parentGroupId: 'grp-members' }),
    ]);

    const ok = validateSubmission(form, {
      members: [
        { member_name: 'Ramesh', member_age: '40' },
        { member_name: 'Sita', member_age: '38' },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.data.members).toEqual([
      { member_name: 'Ramesh', member_age: 40 },
      { member_name: 'Sita', member_age: 38 },
    ]);

    const bad = validateSubmission(form, { members: [{ member_age: '40' }] });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.path).toBe('members[0].member_name');
  });

  it('ignores archived fields', () => {
    const form = version(1, [
      field('current', 'short_text'),
      field('retired', 'short_text', { isArchived: true }),
    ]);

    const result = validateSubmission(form, { current: 'a', retired: 'b' });
    expect(result.data).toEqual({ current: 'a' });
  });
});

describe('a config the field type no longer accepts', () => {
  /*
   * The defect: a failed parse returned `{}`, and `{}` is *no* config rather
   * than the defaults — zod only materialises a `.default()` from a parse that
   * succeeded. On a phone question that left `nationalDigits` undefined and
   * built `^\\d{undefined}$`, which rejects every real phone number and accepts
   * the literal `9{undefined}`. Elsewhere it silently dropped `maxLength`,
   * `min` and `max` with nothing to see.
   */
  const phone = (config: Record<string, unknown>) =>
    field('guardian_phone', 'phone', { config });

  it('still applies the type defaults', () => {
    expect(resolveFieldConfig(phone({ legacyMode: 'gone' }))).toMatchObject({
      nationalDigits: 10,
    });
  });

  it('keeps the settings that are still valid', () => {
    // An admin's deliberate choice should not be discarded because a stale key
    // sits next to it.
    expect(resolveFieldConfig(phone({ legacyMode: 'gone', nationalDigits: 9 }))).toMatchObject({
      nationalDigits: 9,
    });
  });

  it('falls back to the default for a setting whose value is wrong', () => {
    expect(resolveFieldConfig(phone({ nationalDigits: 'nine' }))).toMatchObject({
      nationalDigits: 10,
    });
  });

  it('accepts a real phone number on a question with a broken config', () => {
    // The end of it, as a worker meets it: the question is answerable.
    const form = version(1, [phone({ legacyMode: 'gone' })]);
    const result = validateSubmission(form, { guardian_phone: '9876543210' });

    expect(result.ok).toBe(true);
    // And the shape that used to slip through no longer does.
    expect(validateSubmission(form, { guardian_phone: '9{undefined}' }).ok).toBe(false);
  });
});
