/**
 * Rendering a submission's answers when translations are missing.
 *
 * The same blank-label failure, one layer up: a reviewer reading a record must
 * see what was asked, whatever language it was captured in.
 */
import { describe, expect, it } from 'vitest';
import { formatAnswers, summariseSubmission } from '../display';
import { field, optionSet, version } from './fixtures';

describe('formatAnswers with incomplete translations', () => {
  it('labels a question in English when the requested language is blank', () => {
    const form = version(1, [
      field('student_name', 'short_text', { label: { en: 'Student name', kn: '' } }),
    ]);

    const [answer] = formatAnswers(form, { student_name: 'Sunita' }, 'kn');

    expect(answer?.label).toBe('Student name');
    expect(answer?.value).toBe('Sunita');
  });

  it('renders a choice answer in English when its option has no translation', () => {
    const set = optionSet('absence', ['illness']);
    set.options[0]!.label = { en: 'Illness', kn: '' };
    const form = version(1, [field('reason', 'single_choice', { optionSet: set })]);

    const [answer] = formatAnswers(form, { reason: 'illness' }, 'kn');

    // Never the bare code, and never blank.
    expect(answer?.value).toBe('Illness');
  });

  it('falls back to the field key only when nothing has any wording', () => {
    const form = version(1, [field('orphan', 'short_text', { label: { en: '', kn: '' } })]);

    const [answer] = formatAnswers(form, { orphan: 'x' }, 'kn');

    expect(answer?.label).toBe('orphan');
  });

  it('summarises a row without blanks', () => {
    const form = version(1, [
      field('name', 'short_text', { label: { en: 'Name', kn: '' } }),
      field('age', 'integer', { label: { en: 'Age', kn: '' } }),
    ]);

    expect(summariseSubmission(form, { name: 'Sunita', age: 12 }, 'kn')).toBe('Sunita · 12');
  });
});

describe('answers that point at a person', () => {
  const SUNITA = 'b8b9cf9f-1111-4222-8333-444455556666';
  const RAVI = 'c4e01b5e-9db6-447b-92f1-ef3919442a3b';

  const names = (id: string): string | null =>
    ({ [SUNITA]: 'Sunita Devi', [RAVI]: 'Ravi Kumar' })[id] ?? null;

  const form = version(1, [field('guardian', 'subject_ref', { label: { en: 'Guardian' } })]);

  it('shows a name once it has something to look one up with', () => {
    const [answer] = formatAnswers(form, { guardian: SUNITA }, 'en', names);

    expect(answer?.value).toBe('Sunita Devi');
    // The id travels alongside, so the screen can link to them.
    expect(answer?.subjectId).toBe(SUNITA);
  });

  it('still prints the uuid for callers that pass no lookup', () => {
    /*
     * The export takes this path. Changing it would move a CSV column, which is
     * a separate, announced change — not something that arrives with a screen.
     */
    const [answer] = formatAnswers(form, { guardian: SUNITA }, 'en');

    expect(answer?.value).toBe(SUNITA);
    expect(answer?.subjectId).toBe(SUNITA);
  });

  it('leaves the id showing when it names nobody', () => {
    // Better a uuid a reader can copy into a support ticket than a confident
    // name belonging to somebody else.
    const stranger = '00000000-0000-4000-8000-000000000000';
    const [answer] = formatAnswers(form, { guardian: stranger }, 'en', names);

    expect(answer?.value).toBe(stranger);
  });

  it('marks nothing as a person when the question is not one', () => {
    const plain = version(1, [field('note', 'short_text')]);
    const [answer] = formatAnswers(plain, { note: SUNITA }, 'en', names);

    // A text answer that happens to look like a uuid is still text.
    expect(answer?.value).toBe(SUNITA);
    expect(answer?.subjectId).toBeUndefined();
  });

  it('reaches inside a repeating group', () => {
    const group = field('members', 'repeat_group', { label: { en: 'Members' } });
    const child = field('who', 'subject_ref', {
      label: { en: 'Who' },
      parentGroupId: group.id,
    });
    const form = version(1, [group, child]);

    const [answer] = formatAnswers(form, { members: [{ who: RAVI }] }, 'en', names);

    expect(answer?.entries?.[0]?.[0]?.value).toBe('Ravi Kumar');
  });

  it('gives a one-line summary a name rather than a uuid', () => {
    // The person timeline reads this, and a row of uuids tells a worker
    // nothing about which record it is.
    expect(summariseSubmission(form, { guardian: SUNITA }, 'en', 2, names)).toBe('Sunita Devi');

    // Unchanged for the callers that have no lookup to give it.
    expect(summariseSubmission(form, { guardian: SUNITA }, 'en')).toBe(SUNITA);
  });
});
