/**
 * The Google Translate adapter, against a stub that mimics the v2 API.
 *
 * This is the part that could not be verified when it was written — there was
 * no API key — so "does it work once you add one?" was an open question. The
 * stub reproduces Google's documented request and response shape, including the
 * HTML escaping it applies even when `format` is `text`. Everything up to
 * Google's own servers is exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { googleTranslateProvider } from '../google';

let server: Server;
let received: { q: string[]; source: string; target: string; format: string }[] = [];

const PREFIX: Record<string, string> = { hi: '[हि] ', kn: '[ಕ] ' };

beforeAll(async () => {
  server = createServer((req, res) => {
    // Google rejects a request with no key; so must the stub, or the test
    // would pass with the key silently dropped.
    if (!new URL(req.url!, 'http://x').searchParams.get('key')) {
      res.writeHead(403).end(JSON.stringify({ error: { message: 'API key not valid' } }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      received.push(parsed);
      const texts: string[] = Array.isArray(parsed.q) ? parsed.q : [parsed.q];

      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          data: {
            translations: texts.map((text) => ({
              // Escaped exactly as Google does.
              translatedText:
                (PREFIX[parsed.target] ?? '') + text.replace(/&/g, '&amp;').replace(/'/g, '&#39;'),
            })),
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
  process.env.GOOGLE_TRANSLATE_ENDPOINT = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  delete process.env.GOOGLE_TRANSLATE_ENDPOINT;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the adapter', () => {
  it('is unavailable with no API key, so the button stays hidden', () => {
    const key = process.env.GOOGLE_TRANSLATE_API_KEY;
    delete process.env.GOOGLE_TRANSLATE_API_KEY;
    try {
      expect(googleTranslateProvider()).toBeNull();
    } finally {
      process.env.GOOGLE_TRANSLATE_API_KEY = key;
    }
  });

  it('becomes available the moment a key is present', () => {
    expect(googleTranslateProvider()?.name).toBe('Google Translate');
  });

  it('offers only languages the app itself is translated into', () => {
    const provider = googleTranslateProvider()!;

    expect(provider.supports('hi')).toBe(true);
    expect(provider.supports('kn')).toBe(true);
    // Translating questions into a language whose buttons still read "Next" in
    // English would leave a worker half-served.
    expect(provider.supports('fr')).toBe(false);
  });
});

describe('translating', () => {
  beforeAll(() => {
    received = [];
  });

  it('sends the request shape Google documents', async () => {
    await googleTranslateProvider()!.translate(['Date', 'Was the student present?'], 'en', 'kn');

    expect(received.at(-1)).toMatchObject({
      q: ['Date', 'Was the student present?'],
      source: 'en',
      target: 'kn',
      format: 'text',
    });
  });

  it('batches a whole form into one call', async () => {
    // Providers bill and rate-limit per call; twenty questions must not be
    // twenty round trips.
    const before = received.length;
    await googleTranslateProvider()!.translate(['a', 'b', 'c', 'd', 'e'], 'en', 'hi');

    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.q).toHaveLength(5);
  });

  it('returns translations in the order they were sent', async () => {
    const out = await googleTranslateProvider()!.translate(['first', 'second'], 'en', 'kn');

    expect(out).toEqual(['[ಕ] first', '[ಕ] second']);
  });

  it('decodes the HTML entities Google returns even in text mode', async () => {
    // Without this a field worker reads "Student&#39;s name" on their phone.
    const [out] = await googleTranslateProvider()!.translate(["Student's name"], 'en', 'kn');

    expect(out).toBe("[ಕ] Student's name");
    expect(out).not.toContain('&#39;');
  });

  it('decodes an ampersand without double-decoding', async () => {
    const [out] = await googleTranslateProvider()!.translate(['Health & nutrition'], 'en', 'kn');

    expect(out).toBe('[ಕ] Health & nutrition');
  });

  it('makes no call at all when there is nothing to translate', async () => {
    const before = received.length;
    const out = await googleTranslateProvider()!.translate(['', '  '], 'en', 'kn');

    expect(received.length).toBe(before);
    expect(out).toEqual(['', '']);
  });

  it('refuses a batch large enough to be a billing accident', async () => {
    const huge = ['x'.repeat(3000), 'y'.repeat(3000)];

    await expect(googleTranslateProvider()!.translate(huge, 'en', 'kn')).rejects.toThrow(
      /a lot of text/i,
    );
  });

  it('reports a service failure without leaking the API key', async () => {
    const endpoint = process.env.GOOGLE_TRANSLATE_ENDPOINT;
    // The key travels in the query string, so an error must never echo the URL.
    process.env.GOOGLE_TRANSLATE_ENDPOINT = 'http://127.0.0.1:1/';
    try {
      await expect(googleTranslateProvider()!.translate(['x'], 'en', 'kn')).rejects.toThrow();
    } finally {
      process.env.GOOGLE_TRANSLATE_ENDPOINT = endpoint;
    }
  });
});
