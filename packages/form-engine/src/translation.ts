import type { I18nText } from './types';

/**
 * Machine translation of organisation-authored content.
 *
 * Only ever fills gaps. It never overwrites text a human has entered, and every
 * result is marked so nobody mistakes a draft for checked copy — a mistranslated
 * health question is worse than an untranslated one, because the worker cannot
 * tell it is wrong.
 *
 * The engine defines the shape; the adapter lives in the app, which is where the
 * API key and the network are.
 */

export interface TranslationProvider {
  readonly name: string;
  /** Languages this provider can produce, as BCP-47 primary tags. */
  supports(locale: string): boolean;
  /** Translates several strings at once — providers charge and rate-limit per call. */
  translate(texts: string[], from: string, to: string): Promise<string[]>;
}

/**
 * Marks which translations came from a machine and have not been checked.
 *
 * Stored alongside the text rather than inside it, so the label itself stays a
 * plain string everywhere it is rendered. A human editing the text clears the
 * flag — see `applyTranslations`.
 */
export const MACHINE_TRANSLATED_KEY = '_machine';

export type MachineFlags = Record<string, boolean>;

export interface TranslatableText {
  text: I18nText;
  /** Locales whose text was machine-generated and not yet reviewed. */
  machine?: MachineFlags;
}

/** Locales that still need text, given what is already there. */
export function missingLocales(text: I18nText, wanted: string[], from = 'en'): string[] {
  return wanted.filter((locale) => locale !== from && !text[locale]?.trim());
}

/**
 * Merges translations in without disturbing existing text.
 *
 * `force` re-translates locales previously filled by a machine but never ones a
 * person has written or corrected.
 */
export function applyTranslations(
  current: TranslatableText,
  incoming: Record<string, string>,
  options: { force?: boolean } = {},
): TranslatableText {
  const text: I18nText = { ...current.text };
  const machine: MachineFlags = { ...(current.machine ?? {}) };

  for (const [locale, translated] of Object.entries(incoming)) {
    const existing = text[locale]?.trim();
    const isHumanWritten = Boolean(existing) && !machine[locale];
    if (isHumanWritten) continue;
    if (existing && !options.force) continue;

    text[locale] = translated;
    machine[locale] = true;
  }

  return { text, machine };
}

/**
 * Records that a person has edited a locale, clearing its machine flag.
 *
 * Called on every manual label edit: the moment someone types over a draft, it
 * stops being a draft.
 */
export function markReviewed(current: TranslatableText, locale: string): MachineFlags {
  const machine = { ...(current.machine ?? {}) };
  delete machine[locale];
  return machine;
}

/** True when any locale is still showing unchecked machine output. */
export function hasUnreviewedTranslations(machine: MachineFlags | undefined): boolean {
  return Object.values(machine ?? {}).some(Boolean);
}
