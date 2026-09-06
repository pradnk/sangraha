import { localise, type I18nText } from '@sangraha/form-engine';

/**
 * Resolves translatable content supplied by the organisation.
 *
 * Product strings live in message catalogues; this is for the labels an NGO
 * types into the form builder. Those are translated by the organisation itself,
 * so coverage is always partial — a form may be complete in Hindi and half-done
 * in Kannada.
 *
 * Falling back to any available translation, rather than showing a blank or a
 * raw key, is deliberate: a worker seeing the question in the wrong language
 * can still answer it, whereas an empty label makes the form unusable.
 */
export function t(text: I18nText | null | undefined, locale: string, fallback = ''): string {
  // Delegates rather than reimplementing. This existed as a second copy of the
  // rule and drifted: it fell back with `??`, which only catches `undefined`, so
  // a label stored as `{ en: '…', kn: '' }` rendered blank for a Kannada worker.
  return localise(text, locale, fallback);
}

/**
 * The languages the product's own strings ship in — what the switcher offers.
 *
 * Distinct from `LANGUAGE_NAMES` below: this is the set with a complete message
 * catalogue in `messages.ts`, and `messages.test.ts` fails if one falls behind.
 * Adding a language here without translating it would leave a field worker
 * looking at English they may not read.
 */
export const UI_LOCALES = ['en', 'hi', 'kn'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/**
 * Every language an organisation may attach translations to, each written in
 * its own script.
 *
 * Broader than `UI_LOCALES` on purpose. An NGO can translate its own form
 * labels, option lists and privacy notices into any of these through the
 * builder without a code change; only the product chrome is limited to the
 * three above.
 *
 * **This is the Eighth Schedule of the Constitution, plus English.** Not an
 * arbitrary shortlist: the DPDP Act gives a person the right to be given the
 * privacy notice in English or any language in that Schedule, at their option.
 * A list of ten made that right unmeetable for speakers of the other twelve —
 * Malayalam and Urdu most conspicuously.
 *
 * Machine translation does not cover all of them. `provider.supports()` gates
 * the offer, and the builder says so plainly rather than silently producing
 * nothing.
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  as: 'অসমীয়া',
  bn: 'বাংলা',
  brx: 'बर’',
  doi: 'डोगरी',
  gu: 'ગુજરાતી',
  hi: 'हिंदी',
  kn: 'ಕನ್ನಡ',
  ks: 'کٲشُر',
  kok: 'कोंकणी',
  mai: 'मैथिली',
  ml: 'മലയാളം',
  mni: 'ꯃꯤꯇꯩ ꯂꯣꯟ',
  mr: 'मराठी',
  ne: 'नेपाली',
  or: 'ଓଡ଼ିଆ',
  pa: 'ਪੰਜਾਬੀ',
  sa: 'संस्कृतम्',
  sat: 'ᱥᱟᱱᱛᱟᱲᱤ',
  sd: 'سنڌي',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  ur: 'اردو',
};

/**
 * Languages written right to left.
 *
 * A notice rendered left-to-right in Urdu is not merely ugly, it is unreadable
 * — and an unreadable notice is worse than none, because it looks like consent
 * was informed. Anything rendering organisation-authored text in a chosen
 * language has to set `dir` from this.
 */
const RTL_LOCALES = new Set(['ur', 'ks', 'sd']);

export const directionOf = (locale: string): 'rtl' | 'ltr' =>
  RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';

/**
 * BCP-47 tags for the browser's speech recognition, which needs a region.
 * Used by the microphone button on text questions.
 */
export const SPEECH_LOCALES: Record<string, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  bn: 'bn-IN',
  kn: 'kn-IN',
  gu: 'gu-IN',
  or: 'or-IN',
  pa: 'pa-IN',
};
