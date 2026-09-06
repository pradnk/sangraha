import 'server-only';
import type { TranslationProvider } from '@sangraha/form-engine';
import { LANGUAGE_NAMES } from '@/lib/i18n';

/**
 * Google Cloud Translation, v2 REST.
 *
 * v2 rather than v3: it authenticates with a plain API key, which an NGO's own
 * IT person can create and paste into `.env` without a service account, a JSON
 * key file or a GCP project structure. v3's extra features are not needed to
 * translate a form label.
 *
 * Absent an API key this reports itself unavailable and the UI hides the button,
 * rather than offering something that fails when pressed.
 */
const DEFAULT_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

/**
 * Overridable so an organisation behind a corporate proxy, or one using an
 * API-compatible service, can point this elsewhere — and so the whole path can
 * be exercised against a stub without calling Google.
 */
function endpoint(): string {
  return process.env.GOOGLE_TRANSLATE_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

/**
 * Google HTML-escapes its output even with `format: 'text'`.
 *
 * Left alone, "Student's name" comes back as "Student&#39;s name" and that is
 * what a field worker would read on the phone. The entity set it emits is small
 * and fixed, so decoding it here is exact rather than a general HTML parse.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Ampersand last, or "&amp;lt;" would decode twice.
    .replace(/&amp;/g, '&');
}

/** Google charges per character, so a runaway form cannot run up a bill. */
const MAX_CHARS_PER_CALL = 5000;

export function googleTranslateProvider(): TranslationProvider | null {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    name: 'Google Translate',

    supports(locale) {
      // Constrained to the languages the app itself is translated into.
      // Translating questions into a language whose buttons still say "Next" in
      // English leaves a worker half-served; expanding this means shipping the
      // product strings too.
      return locale in LANGUAGE_NAMES;
    },

    async translate(texts, from, to) {
      const nonEmpty = texts.filter((t) => t.trim());
      if (nonEmpty.length === 0) return texts.map(() => '');

      const totalChars = nonEmpty.reduce((sum, t) => sum + t.length, 0);
      if (totalChars > MAX_CHARS_PER_CALL) {
        throw new Error(
          `That is a lot of text to translate at once (${totalChars} characters). Translate one form at a time.`,
        );
      }

      const response = await fetch(`${endpoint()}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: texts, source: from, target: to, format: 'text' }),
      });

      if (!response.ok) {
        // The API key is in the URL, so the raw body must never reach a client.
        const detail = (await response.text()).slice(0, 200);
        console.error('Google Translate failed', response.status, detail);
        throw new Error('The translation service did not respond. Please try again.');
      }

      const body = (await response.json()) as {
        data?: { translations?: { translatedText: string }[] };
      };

      const translations = body.data?.translations ?? [];
      return texts.map((_, index) =>
        translations[index] ? decodeEntities(translations[index]!.translatedText) : '',
      );
    },
  };
}
