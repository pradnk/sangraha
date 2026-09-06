import 'server-only';
import type { TranslationProvider } from '@sangraha/form-engine';
import { googleTranslateProvider } from './google';
import { googleServiceAccountProvider } from './service-account';

/**
 * The configured translation provider, or null when none is set up.
 *
 * One place to add another adapter — Azure, Bhashini, a local model — without
 * anything else in the app knowing which is in use.
 *
 * A service account wins over an API key when both are present: it is the
 * stronger credential, and configuring one is the more deliberate act, so it is
 * unlikely to be the leftover of the two.
 */
export function getTranslationProvider(): TranslationProvider | null {
  return googleServiceAccountProvider() ?? googleTranslateProvider();
}

export function isTranslationAvailable(): boolean {
  return getTranslationProvider() !== null;
}

/** Which credential is in use, for the settings screen to report. */
export function translationProviderName(): string | null {
  return getTranslationProvider()?.name ?? null;
}
