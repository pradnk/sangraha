/**
 * Guards the message catalogues against drift.
 *
 * With three shipped languages it is easy to add a string in English and forget
 * the other two. The fallback in `m()` means that failure is silent — the
 * worker just sees English, in an app whose whole premise is that they should
 * not have to. These tests turn that into a build failure instead.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGE_NAMES, UI_LOCALES } from '../i18n';
import { MESSAGES, m } from '../messages';

const englishKeys = Object.keys(MESSAGES.en).sort();

describe('message catalogues', () => {
  it('ships a catalogue for every offered language', () => {
    for (const locale of UI_LOCALES) {
      expect(MESSAGES, `no catalogue for "${locale}"`).toHaveProperty(locale);
    }
  });

  it('offers exactly English, Hindi and Kannada', () => {
    expect([...UI_LOCALES]).toEqual(['en', 'hi', 'kn']);
  });

  it.each([...UI_LOCALES])('has every string translated in %s', (locale) => {
    const catalogue = MESSAGES[locale as keyof typeof MESSAGES];
    const missing = englishKeys.filter((key) => !(key in catalogue));
    const extra = Object.keys(catalogue).filter((key) => !englishKeys.includes(key));

    expect(missing, `untranslated in ${locale}`).toEqual([]);
    expect(extra, `present in ${locale} but not in English`).toEqual([]);
  });

  it.each([...UI_LOCALES])('leaves no string blank in %s', (locale) => {
    const catalogue = MESSAGES[locale as keyof typeof MESSAGES] as Record<string, string>;
    const blank = Object.entries(catalogue)
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key);

    expect(blank).toEqual([]);
  });

  it('keeps every placeholder intact across translations', () => {
    // A dropped `{minutes}` turns "wait 15 minutes" into "wait minutes".
    const placeholders = (value: string) => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

    for (const key of englishKeys) {
      const expected = placeholders(MESSAGES.en[key as keyof typeof MESSAGES.en]);
      for (const locale of UI_LOCALES) {
        const catalogue = MESSAGES[locale as keyof typeof MESSAGES] as Record<string, string>;
        expect(placeholders(catalogue[key]!), `${locale}.${key}`).toEqual(expected);
      }
    }
  });

  it('actually returns the translation, not an English fallback', () => {
    // Catches a catalogue that exists but was copied from English wholesale.
    expect(m('hi', 'signIn')).not.toBe(m('en', 'signIn'));
    expect(m('kn', 'signIn')).not.toBe(m('en', 'signIn'));
    expect(m('kn', 'save')).not.toBe(m('en', 'save'));
  });

  it('substitutes variables', () => {
    expect(m('en', 'accountLocked', { minutes: 15 })).toContain('15');
    expect(m('kn', 'accountLocked', { minutes: 15 })).toContain('15');
    expect(m('kn', 'accountLocked', { minutes: 15 })).not.toContain('{minutes}');
  });

  it('falls back to English for a language with no catalogue', () => {
    // An organisation may enable a language the product chrome does not ship.
    expect(m('ta', 'signIn')).toBe(MESSAGES.en.signIn);
  });

  it('names every offered language in its own script', () => {
    for (const locale of UI_LOCALES) {
      expect(LANGUAGE_NAMES[locale], `no display name for "${locale}"`).toBeTruthy();
    }
    expect(LANGUAGE_NAMES.kn).toBe('ಕನ್ನಡ');
    expect(LANGUAGE_NAMES.hi).toBe('हिंदी');
  });
});
