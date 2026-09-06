/**
 * Resolving translatable text.
 *
 * The bug these exist for: a Kannada field worker was shown a question with no
 * words in it — just the required asterisk. The label was stored as
 * `{ en: 'Name', hi: '', kn: '' }`, written that way by the form builder as the
 * admin tabbed through its per-language inputs, and the old resolver used `??`,
 * which only catches `undefined`.
 *
 * A worker must never be asked a question they cannot see.
 */
import { describe, expect, it } from 'vitest';
import { isBlank, localise, pruneBlank, translatedLocales } from '../i18n';
import type { I18nText } from '../types';

describe('localise', () => {
  it('falls back to English when the language is an empty string', () => {
    // The exact shape found in the database.
    const label = { en: 'Name', hi: '', kn: '' };

    expect(localise(label, 'kn')).toBe('Name');
    expect(localise(label, 'hi')).toBe('Name');
  });

  it('falls back to English when the language is missing entirely', () => {
    expect(localise({ en: 'Name' }, 'kn')).toBe('Name');
  });

  it('treats whitespace as no translation at all', () => {
    expect(localise({ en: 'Name', kn: '   ' }, 'kn')).toBe('Name');
    expect(localise({ en: 'Name', kn: '\n\t' }, 'kn')).toBe('Name');
  });

  it('prefers the requested language when it has real text', () => {
    expect(localise({ en: 'Name', kn: 'ಹೆಸರು' }, 'kn')).toBe('ಹೆಸರು');
  });

  it('uses any other language rather than showing nothing', () => {
    // Wrong language beats blank: it can still be answered.
    expect(localise({ hi: 'नाम', en: '' }, 'kn')).toBe('नाम');
  });

  it('returns the caller fallback only when no language has anything', () => {
    expect(localise({ en: '', hi: '', kn: '' }, 'kn', 'student_name')).toBe('student_name');
    expect(localise({}, 'kn', 'student_name')).toBe('student_name');
    expect(localise(null, 'kn', 'student_name')).toBe('student_name');
    expect(localise(undefined, 'kn', 'student_name')).toBe('student_name');
  });

  it('never returns an empty string when any language has text', () => {
    // The invariant, stated directly.
    const shapes: I18nText[] = [
      { en: 'Question' },
      { en: 'Question', kn: '' },
      { en: '', kn: 'ಪ್ರಶ್ನೆ' },
      { hi: 'सवाल', kn: '  ' },
      { en: '   ', hi: '', kn: 'ಪ್ರಶ್ನೆ' },
    ];

    for (const shape of shapes) {
      for (const locale of ['en', 'hi', 'kn']) {
        expect(localise(shape, locale), `${JSON.stringify(shape)} @ ${locale}`).not.toBe('');
      }
    }
  });

  it('trims what it returns', () => {
    expect(localise({ en: '  Name  ' }, 'en')).toBe('Name');
  });
});

describe('pruneBlank', () => {
  it('drops the empty entries the builder writes while tabbing through', () => {
    expect(pruneBlank({ en: 'Name', hi: '', kn: '   ' })).toEqual({ en: 'Name' });
  });

  it('trims what it keeps', () => {
    expect(pruneBlank({ en: '  Name  ', kn: 'ಹೆಸರು' })).toEqual({ en: 'Name', kn: 'ಹೆಸರು' });
  });

  it('can return nothing, which means untranslated rather than blank', () => {
    expect(pruneBlank({ en: '', kn: '' })).toEqual({});
  });
});

describe('isBlank and translatedLocales', () => {
  it('recognises every shape of nothing', () => {
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank(null)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('   ')).toBe(true);
    expect(isBlank('x')).toBe(false);
  });

  it('reports only the languages that actually have text', () => {
    expect(translatedLocales({ en: 'Name', hi: '', kn: 'ಹೆಸರು' })).toEqual(['en', 'kn']);
    expect(translatedLocales(null)).toEqual([]);
  });
});
