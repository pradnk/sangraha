import 'server-only';
import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';
import type { TranslationProvider } from '@sangraha/form-engine';
import { LANGUAGE_NAMES } from '@/lib/i18n';

/**
 * Google Cloud Translation authenticated with a service account.
 *
 * The other adapter takes a plain API key, which is simpler. This exists because
 * the Cloud console steers people towards service accounts — you ask for a
 * credential and it hands you a JSON file — and because many organisations
 * disable API keys by policy. Being told "that is the wrong kind of key, go and
 * make a different one" is a poor answer when the credential in hand is the
 * stronger of the two.
 *
 * The flow is the standard one: sign a short-lived JWT with the account's
 * private key, exchange it for an access token, send that as a bearer token.
 * The key itself never leaves this process and never appears in a URL — which
 * is the main thing it has over an API key.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const SCOPE = 'https://www.googleapis.com/auth/cloud-translation';
const MAX_CHARS_PER_CALL = 5000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/**
 * Loads the credential.
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` is Google's own convention — a path to the
 * downloaded file — and is what most people already have. `GOOGLE_TRANSLATE_CREDENTIALS`
 * takes the JSON directly, base64 or raw, for platforms with no writable
 * filesystem to put a file on.
 */
/** The configured service account, or null when none is set up. */
export function readServiceAccount(): ServiceAccount | null {
  return loadServiceAccount();
}

/**
 * A Google access token for one scope.
 *
 * Exported so features other than translation — reading a Google Sheet — can
 * reuse the same credential rather than asking an organisation to configure a
 * second one.
 */
export async function googleAccessToken(
  account: ServiceAccount,
  scope: string,
): Promise<string> {
  return getAccessToken(account, scope);
}

function loadServiceAccount(): ServiceAccount | null {
  const inline = process.env.GOOGLE_TRANSLATE_CREDENTIALS?.trim();
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

  let raw: string | undefined;
  try {
    if (inline) {
      // Base64 is the usual way to get JSON through a platform's env UI intact.
      raw = inline.startsWith('{') ? inline : Buffer.from(inline, 'base64').toString('utf8');
    } else if (path) {
      raw = readFileSync(path, 'utf8');
    }
  } catch (error) {
    console.error('Translation credentials could not be read', error);
    return null;
  }

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount> & { type?: string };
    if (!parsed.client_email || !parsed.private_key) {
      console.error(
        'Translation credentials are missing client_email or private_key. ' +
          'This should be a service account key file, not an OAuth client or an API key.',
      );
      return null;
    }
    return parsed as ServiceAccount;
  } catch {
    console.error('Translation credentials are not valid JSON.');
    return null;
  }
}

/**
 * Cached access token.
 *
 * Google issues these for an hour. Re-signing a JWT and round-tripping for a
 * token on every translate call would triple the latency and the request count
 * for no reason.
 */
/**
 * Keyed by scope.
 *
 * It used to be a single slot, which was correct while translation was the only
 * caller and would have been a real bug the moment there were two: reading a
 * Google Sheet would have been handed a translation-scoped token and refused
 * with a 403 that pointed nowhere near the cause.
 */
const cached = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(account: ServiceAccount, scope: string): Promise<string> {
  // A minute of margin, so a token cannot expire mid-flight.
  const hit = cached.get(scope);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const key = await importPKCS8(account.private_key.replace(/\\n/g, '\n'), 'RS256');
  const tokenUri = account.token_uri ?? TOKEN_ENDPOINT;

  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(account.client_email)
    .setAudience(tokenUri)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    // The body can echo the assertion; log a truncated form, never the key.
    console.error('Google token exchange failed', response.status, (await response.text()).slice(0, 200));
    throw new Error(
      'Could not authenticate with the translation service. Check that the Cloud Translation API is enabled for this service account.',
    );
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  cached.set(scope, {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  });
  return body.access_token;
}

/** Exposed so tests can start from a clean state. */
export function resetTokenCache(): void {
  cached.clear();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function googleServiceAccountProvider(): TranslationProvider | null {
  const account = loadServiceAccount();
  if (!account) return null;

  return {
    name: 'Google Translate (service account)',

    supports(locale) {
      return locale in LANGUAGE_NAMES;
    },

    async translate(texts, from, to) {
      const nonEmpty = texts.filter((text) => text.trim());
      if (nonEmpty.length === 0) return texts.map(() => '');

      const totalChars = nonEmpty.reduce((sum, text) => sum + text.length, 0);
      if (totalChars > MAX_CHARS_PER_CALL) {
        throw new Error(
          `That is a lot of text to translate at once (${totalChars} characters). Translate one form at a time.`,
        );
      }

      const token = await getAccessToken(account, SCOPE);
      const endpoint = process.env.GOOGLE_TRANSLATE_ENDPOINT?.trim() || TRANSLATE_ENDPOINT;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The credential is a header here, not a query parameter — so it does
          // not end up in access logs or a referrer.
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ q: texts, source: from, target: to, format: 'text' }),
      });

      if (!response.ok) {
        // A stale cached token would otherwise keep failing until it expired.
        if (response.status === 401) cached.clear();
        console.error('Google Translate failed', response.status, (await response.text()).slice(0, 200));
        throw new Error('The translation service did not respond. Please try again.');
      }

      const body = (await response.json()) as {
        data?: { translations?: { translatedText: string }[] };
      };
      const translations = body.data?.translations ?? [];

      // Google HTML-escapes even in text mode; without decoding, "Student's
      // name" reaches a field worker as "Student&#39;s name".
      return texts.map((_, index) =>
        translations[index] ? decodeEntities(translations[index]!.translatedText) : '',
      );
    },
  };
}
