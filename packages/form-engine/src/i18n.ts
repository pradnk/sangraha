import type { I18nText } from './types';

/**
 * Resolving organisation-authored text.
 *
 * The one definition of how a translatable label becomes a string. It lives here,
 * importing nothing but types, so both the field types and the display helpers
 * can use it without a circular import — and so there is no second, subtly
 * different copy of the rule.
 *
 * The rule that matters: **a blank translation is not a translation.**
 *
 * This is not hypothetical. The form builder renders an input per language, and
 * tabbing through them writes an empty string for each one touched, so a label
 * becomes `{ en: 'Was the student present?', hi: '', kn: '' }`. Resolved with
 * `??` — which only catches `undefined` — a Kannada worker was shown a blank
 * question with nothing but the required asterisk beside it. A worker must never
 * be asked a question they cannot see.
 */

/** True when there is no usable text: absent, empty, or only whitespace. */
export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/**
 * Resolves translatable text, preferring the requested language.
 *
 * Order: the requested locale, then English, then any other language that has
 * something, then the caller's fallback. English sits second deliberately — it
 * is the one language the product guarantees, and it is always enabled for every
 * organisation, so it is the dependable rung on the way down.
 */
export function localise(
  text: I18nText | null | undefined,
  locale: string,
  fallback = '',
): string {
  if (!text) return fallback;

  const requested = text[locale];
  if (!isBlank(requested)) return requested!.trim();

  const english = text.en;
  if (!isBlank(english)) return english!.trim();

  // Any language beats nothing. A worker who can see the question in the wrong
  // language can still answer it; a blank one stops them entirely.
  for (const value of Object.values(text)) {
    if (!isBlank(value)) return value.trim();
  }

  return fallback;
}

/**
 * Drops blank entries.
 *
 * Used on the way *in*, so the resolution above is a safety net rather than the
 * only thing standing between a worker and an empty question. Storing `''`
 * also makes "has this been translated?" ambiguous everywhere else.
 */
export function pruneBlank(text: I18nText): I18nText {
  const cleaned: I18nText = {};
  for (const [locale, value] of Object.entries(text)) {
    if (!isBlank(value)) cleaned[locale] = value.trim();
  }
  return cleaned;
}

/** Locales that have usable text. */
export function translatedLocales(text: I18nText | null | undefined): string[] {
  if (!text) return [];
  return Object.entries(text)
    .filter(([, value]) => !isBlank(value))
    .map(([locale]) => locale);
}
