/**
 * The secret that signs sessions has to be a secret.
 *
 * The defect: `.env.example` shipped
 * `AUTH_SECRET=replace-me-with-a-random-32-byte-secret`, which is 39 characters
 * and so passed `session.ts`'s length check. An installation that copied the
 * example and never replaced the value worked perfectly, signing every session
 * cookie with a string published in this repository — so anyone could mint a
 * session for any organisation and any role without a PIN. The consent pepper
 * shared the same variable and checked only that something was set.
 *
 * No database needed — the whole of it is a string.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authSecret } from '../auth/secret';

const ENV_KEYS = ['AUTH_SECRET', 'VERCEL', 'CI'];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** 44 characters, the shape `openssl rand -base64 32` produces. */
const REAL = 'kqf3Xj8vQ2pR7mZ1yT6bN0wL4sH9cV5aD8gJ2kE7uY0=';

describe('the auth secret', () => {
  it('accepts what the documented command produces', () => {
    process.env.AUTH_SECRET = REAL;
    expect(authSecret()).toBe(REAL);
  });

  it('refuses the placeholder this repository used to ship', () => {
    // The regression itself. Long enough to pass a length check, and useless.
    process.env.AUTH_SECRET = 'replace-me-with-a-random-32-byte-secret';
    expect(process.env.AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(() => authSecret()).toThrow(/placeholder/i);
  });

  it('refuses anything still saying replace-me, at any length', () => {
    process.env.AUTH_SECRET = `replace-me-${REAL}`;
    expect(() => authSecret()).toThrow(/placeholder/i);
  });

  it('refuses the words people type into a field they mean to come back to', () => {
    for (const value of ['changeme', 'secret', 'password', 'your-secret-here']) {
      process.env.AUTH_SECRET = value;
      expect(() => authSecret(), value).toThrow();
    }
  });

  it('refuses a short secret, and says how short', () => {
    process.env.AUTH_SECRET = 'abcdefghij';
    expect(() => authSecret()).toThrow(/10 characters/);
  });

  it('treats whitespace as absent, and does not carry it into the key', () => {
    // A trailing newline from a copied value would otherwise become part of the
    // signing key, and a value that is only whitespace would pass a length
    // check while being nothing at all.
    process.env.AUTH_SECRET = '                                        ';
    expect(() => authSecret()).toThrow(/not set/i);

    process.env.AUTH_SECRET = `  ${REAL}\n`;
    expect(authSecret()).toBe(REAL);
  });

  it('never puts the value in the message', () => {
    // These land in build logs and error trackers.
    process.env.AUTH_SECRET = 'short-but-distinctive-zzz';
    try {
      authSecret();
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('short-but-distinctive-zzz');
      expect((error as Error).message).toContain('25 characters');
    }
  });

  it('tells a deployment to use its platform, and a clone to use .env', () => {
    delete process.env.AUTH_SECRET;

    delete process.env.VERCEL;
    delete process.env.CI;
    expect(authSecretError()).toContain('.env at the repo root');

    process.env.VERCEL = '1';
    const deployed = authSecretError();
    expect(deployed).toContain('environment variables');
    expect(deployed, 'a build has no .env to edit').not.toContain('.env at the repo root');
  });

  it('is what the example file leaves for you to fill in', () => {
    /*
     * The other half of the fix. Rejecting the placeholder in code while the
     * example still offered one would break every fresh clone; the example has
     * to stop supplying a value that cannot work.
     */
    const example = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.env.example'),
      'utf8',
    );
    const line = example.split('\n').find((l) => l.startsWith('AUTH_SECRET='));

    expect(line, '.env.example should still define the variable').toBe('AUTH_SECRET=');
  });
});

function authSecretError(): string {
  try {
    authSecret();
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}
