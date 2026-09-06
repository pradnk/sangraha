/**
 * The logo storage boundary.
 *
 * The browser resizes before uploading, but that is a convenience — this is the
 * boundary. A request that did not come from our form has to be refused here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_LOGO_MIMES,
  MAX_LOGO_BYTES,
  getOrgLogoBySlug,
  getOrgLogoStamp,
  removeOrgLogo,
  setOrgLogo,
} from '../queries/branding';
import { closeHarness, createTestOrg, dropTestOrg, hasDatabase, ownerDb, type TestOrg } from './harness';

describe('logo limits', () => {
  it('caps size well below any request body limit', () => {
    // Next.js server actions default to 1 MB; this has to stay comfortably under.
    expect(MAX_LOGO_BYTES).toBeLessThan(1024 * 1024);
  });

  it('accepts raster formats only', () => {
    // SVG is a document that can carry script. It is rasterised in the browser
    // and never stored as SVG, so it must not be storable here either.
    expect(ALLOWED_LOGO_MIMES).not.toContain('image/svg+xml');
    expect(ALLOWED_LOGO_MIMES).toContain('image/png');
    expect(ALLOWED_LOGO_MIMES).toContain('image/webp');
  });
});

describe.skipIf(!hasDatabase)('logo storage', () => {
  let org: TestOrg;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeAll(async () => {
    org = await createTestOrg('branding');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('stores and serves a logo unchanged', async () => {
    expect(await setOrgLogo(ownerDb(), org.id, { mime: 'image/png', bytes: png })).toEqual({
      ok: true,
    });

    const stored = await getOrgLogoBySlug(ownerDb(), org.slug);
    expect(stored?.mime).toBe('image/png');
    // Byte-for-byte: a logo must not be silently re-encoded on the way through.
    expect(Buffer.from(stored!.bytes).equals(png)).toBe(true);
  });

  it('refuses an oversized upload rather than storing it', async () => {
    const tooBig = Buffer.alloc(MAX_LOGO_BYTES + 1, 1);

    expect(await setOrgLogo(ownerDb(), org.id, { mime: 'image/png', bytes: tooBig })).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('refuses an SVG even if one reaches this far', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

    expect(await setOrgLogo(ownerDb(), org.id, { mime: 'image/svg+xml', bytes: svg })).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
  });

  it('refuses an empty file', async () => {
    expect(
      await setOrgLogo(ownerDb(), org.id, { mime: 'image/png', bytes: Buffer.alloc(0) }),
    ).toEqual({ ok: false, reason: 'empty' });
  });

  it('replaces an existing logo and moves the cache stamp forward', async () => {
    await setOrgLogo(ownerDb(), org.id, { mime: 'image/png', bytes: png });
    const first = await getOrgLogoStamp(ownerDb(), org.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await setOrgLogo(ownerDb(), org.id, { mime: 'image/webp', bytes: png });
    const second = await getOrgLogoStamp(ownerDb(), org.id);

    // The stamp is what busts an immutable cache; a replacement that did not
    // move it would leave every worker looking at the old mark forever.
    expect(second).toBeGreaterThan(first!);
  });

  it('reports no logo once removed, so the name is shown instead', async () => {
    await setOrgLogo(ownerDb(), org.id, { mime: 'image/png', bytes: png });
    await removeOrgLogo(ownerDb(), org.id);

    expect(await getOrgLogoStamp(ownerDb(), org.id)).toBeNull();
    expect(await getOrgLogoBySlug(ownerDb(), org.slug)).toBeNull();
  });
});
