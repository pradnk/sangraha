import { getOrgLogoBySlug, getOwnerDb } from '@sangraha/db';

/**
 * Serves an organisation's logo.
 *
 * Public, and on the owner connection, because the login screen shows it before
 * anyone is signed in — there is no tenant context to read it under. A logo is
 * public branding by nature; the only thing it reveals is that an organisation
 * with that slug exists, which the login screen already shows.
 *
 * Immutable caching is safe because the URL carries a `v` stamp that changes
 * whenever the logo does.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const logo = await getOrgLogoBySlug(getOwnerDb(), slug);

  if (!logo) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(logo.bytes), {
    headers: {
      'Content-Type': logo.mime,
      'Content-Length': String(logo.bytes.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Uploaded bytes served from our own origin: refuse to let a browser
      // second-guess the type, and give it nothing to execute if it tries.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
