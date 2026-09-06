/**
 * The service-account adapter, against stubs for Google's token exchange and
 * translation endpoints.
 *
 * This path exists because the Cloud console hands you a JSON key file when you
 * ask for a credential, so that is what people arrive with. The JWT is signed
 * with a real generated RSA key here and verified by the stub, so the signing —
 * the part most likely to be subtly wrong — is genuinely exercised.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { googleServiceAccountProvider, resetTokenCache } from '../service-account';

let tokenServer: Server;
let translateServer: Server;
let keyPath: string;
let publicKeyPem: string;

let tokenCalls = 0;
let lastAssertion = '';
let lastAuthHeader = '';
let tokenLifetime = 3600;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  publicKeyPem = await exportSPKI(publicKey);

  // Google embeds literal \n in the JSON; the adapter has to unescape them.
  const pkcs8 = (await exportPKCS8(privateKey)).replace(/\n/g, '\\n');

  tokenServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      tokenCalls += 1;
      const params = new URLSearchParams(body);
      lastAssertion = params.get('assertion') ?? '';
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ access_token: 'stub-access-token', expires_in: tokenLifetime }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, resolve));

  translateServer = createServer((req, res) => {
    lastAuthHeader = req.headers.authorization ?? '';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { q } = JSON.parse(body) as { q: string[] };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          data: {
            translations: q.map((text) => ({
              translatedText: `[ಕ] ${text.replace(/'/g, '&#39;')}`,
            })),
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => translateServer.listen(0, resolve));

  const tokenPort = (tokenServer.address() as { port: number }).port;
  const translatePort = (translateServer.address() as { port: number }).port;

  keyPath = join(tmpdir(), `sangraha-sa-${process.pid}.json`);
  writeFileSync(
    keyPath,
    JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'sangraha@test-project.iam.gserviceaccount.com',
      private_key: pkcs8,
      token_uri: `http://127.0.0.1:${tokenPort}/token`,
    }),
  );

  process.env.GOOGLE_TRANSLATE_ENDPOINT = `http://127.0.0.1:${translatePort}/`;
});

afterEach(() => {
  resetTokenCache();
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_TRANSLATE_CREDENTIALS;
});

afterAll(async () => {
  delete process.env.GOOGLE_TRANSLATE_ENDPOINT;
  await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  await new Promise<void>((resolve) => translateServer.close(() => resolve()));
});

describe('loading the credential', () => {
  it('reads the key file Google gives you to download', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    expect(googleServiceAccountProvider()?.name).toContain('service account');
  });

  it('accepts the JSON inline, for platforms with no filesystem', () => {
    process.env.GOOGLE_TRANSLATE_CREDENTIALS = JSON.stringify({
      client_email: 'a@b.iam.gserviceaccount.com',
      private_key: 'x',
    });
    expect(googleServiceAccountProvider()).not.toBeNull();
  });

  it('accepts it base64-encoded, which is how it survives an env var UI', () => {
    process.env.GOOGLE_TRANSLATE_CREDENTIALS = Buffer.from(
      JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: 'x' }),
    ).toString('base64');
    expect(googleServiceAccountProvider()).not.toBeNull();
  });

  it('is unavailable when nothing is configured', () => {
    expect(googleServiceAccountProvider()).toBeNull();
  });

  it('is unavailable when the file is not a service account key', () => {
    // The mistake this catches: pasting an OAuth client, or an API key wrapped
    // in JSON, and wondering why nothing happens.
    process.env.GOOGLE_TRANSLATE_CREDENTIALS = JSON.stringify({ installed: { client_id: 'x' } });
    expect(googleServiceAccountProvider()).toBeNull();
  });

  it('is unavailable when the file is not JSON at all', () => {
    process.env.GOOGLE_TRANSLATE_CREDENTIALS = 'AIzaSyNotAServiceAccount';
    expect(googleServiceAccountProvider()).toBeNull();
  });
});

describe('authenticating', () => {
  it('signs an assertion the key actually verifies', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    await googleServiceAccountProvider()!.translate(['Date'], 'en', 'kn');

    const { payload } = await jwtVerify(lastAssertion, await importSPKI(publicKeyPem, 'RS256'), {
      audience: lastAssertionAudience(),
    });

    expect(payload.iss).toBe('sangraha@test-project.iam.gserviceaccount.com');
    expect(payload.scope).toBe('https://www.googleapis.com/auth/cloud-translation');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('sends the token as a bearer header, never in the URL', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    await googleServiceAccountProvider()!.translate(['Date'], 'en', 'kn');

    // The point of a service account over an API key: the credential stays out
    // of access logs and referrers.
    expect(lastAuthHeader).toBe('Bearer stub-access-token');
  });

  it('reuses the access token instead of re-authenticating every call', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    const provider = googleServiceAccountProvider()!;

    tokenCalls = 0;
    await provider.translate(['one'], 'en', 'kn');
    await provider.translate(['two'], 'en', 'kn');
    await provider.translate(['three'], 'en', 'kn');

    expect(tokenCalls).toBe(1);
  });

  it('re-authenticates rather than using a token about to expire', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    tokenLifetime = 30; // inside the safety margin
    try {
      const provider = googleServiceAccountProvider()!;
      tokenCalls = 0;
      await provider.translate(['one'], 'en', 'kn');
      await provider.translate(['two'], 'en', 'kn');

      expect(tokenCalls).toBe(2);
    } finally {
      tokenLifetime = 3600;
    }
  });
});

describe('translating', () => {
  it('returns decoded translations in order', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    const out = await googleServiceAccountProvider()!.translate(
      ["Student's name", 'Age'],
      'en',
      'kn',
    );

    expect(out).toEqual(["[ಕ] Student's name", '[ಕ] Age']);
  });

  it('makes no call when there is nothing to translate', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    tokenCalls = 0;
    const out = await googleServiceAccountProvider()!.translate(['', '  '], 'en', 'kn');

    expect(out).toEqual(['', '']);
    expect(tokenCalls).toBe(0);
  });
});

/** The audience the adapter signs for is the account's own token_uri. */
function lastAssertionAudience(): string {
  const port = (tokenServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/token`;
}
