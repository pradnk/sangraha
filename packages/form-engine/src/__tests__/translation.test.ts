/**
 * Filling in translations without destroying anything.
 *
 * The bug these guard: translating a form into two languages applied the second
 * result to the *original* label and silently dropped the first, so an
 * organisation with Hindi and Kannada ended up with only Kannada.
 */
import { describe, expect, it } from 'vitest';
import { applyTranslations, hasUnreviewedTranslations, markReviewed, missingLocales } from '../translation';

describe('applyTranslations', () => {
  it('accumulates across languages instead of overwriting', () => {
    let state = { text: { en: 'Income' }, machine: {} };

    state = applyTranslations(state, { hi: '[हि] Income' }) as typeof state;
    state = applyTranslations(state, { kn: '[ಕ] Income' }) as typeof state;

    expect(state.text).toEqual({
      en: 'Income',
      hi: '[हि] Income',
      kn: '[ಕ] Income',
    });
    expect(state.machine).toEqual({ hi: true, kn: true });
  });

  it('never overwrites text a person wrote', () => {
    // The whole point of gap-filling: hand-correct a few, machine-fill the rest,
    // and running it again must not undo the corrections.
    const state = applyTranslations(
      { text: { en: 'Income', kn: 'ಕುಟುಂಬದ ಆದಾಯ' }, machine: {} },
      { kn: '[machine] Income' },
    );

    expect(state.text.kn).toBe('ಕುಟುಂಬದ ಆದಾಯ');
    expect(state.machine?.kn).toBeFalsy();
  });

  it('replaces its own earlier output when forced', () => {
    const first = applyTranslations({ text: { en: 'Income' }, machine: {} }, { kn: 'old' });
    const second = applyTranslations(first, { kn: 'new' }, { force: true });

    expect(second.text.kn).toBe('new');
  });

  it('leaves its own earlier output alone when not forced', () => {
    const first = applyTranslations({ text: { en: 'Income' }, machine: {} }, { kn: 'old' });
    const second = applyTranslations(first, { kn: 'new' });

    expect(second.text.kn).toBe('old');
  });

  it('clears the unreviewed flag when a person edits', () => {
    const filled = applyTranslations({ text: { en: 'Income' }, machine: {} }, { kn: 'draft' });
    expect(hasUnreviewedTranslations(filled.machine)).toBe(true);

    const reviewed = markReviewed(filled, 'kn');
    expect(hasUnreviewedTranslations(reviewed)).toBe(false);
  });
});

describe('missingLocales', () => {
  it('treats a blank translation as missing', () => {
    // Same rule as localise: an empty string is not a translation.
    expect(missingLocales({ en: 'Income', kn: '' }, ['hi', 'kn'])).toEqual(['hi', 'kn']);
    expect(missingLocales({ en: 'Income', kn: 'ಆದಾಯ' }, ['kn'])).toEqual([]);
  });

  it('never reports the source language as missing', () => {
    expect(missingLocales({ en: 'Income' }, ['en', 'kn'])).toEqual(['kn']);
  });
});
