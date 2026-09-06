import { eq } from 'drizzle-orm';
import type { DbLike } from '../client';
import { organisationBranding } from '../schema/branding';
import { organisations } from '../schema/tenancy';

/**
 * Organisation logos.
 *
 * Kept small on purpose: this is a header mark, not an image library. The cap
 * is enforced here as well as in the upload form, because the form is a
 * convenience and this is the boundary.
 */
export const MAX_LOGO_BYTES = 256 * 1024;

/**
 * SVG is excluded deliberately.
 *
 * An SVG is a document that can carry script. Served from our own origin it is
 * a stored-XSS vector the moment anything renders it inline rather than in an
 * `<img>`, and "nobody will ever inline it" is not a property one can maintain.
 * Raster only.
 */
export const ALLOWED_LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type LogoMime = (typeof ALLOWED_LOGO_MIMES)[number];

export type SetLogoResult =
  | { ok: true }
  | { ok: false; reason: 'too_large' | 'unsupported_type' | 'empty' };

export async function setOrgLogo(
  db: DbLike,
  orgId: string,
  input: { mime: string; bytes: Buffer },
): Promise<SetLogoResult> {
  if (input.bytes.byteLength === 0) return { ok: false, reason: 'empty' };
  if (input.bytes.byteLength > MAX_LOGO_BYTES) return { ok: false, reason: 'too_large' };
  if (!ALLOWED_LOGO_MIMES.includes(input.mime as LogoMime)) {
    return { ok: false, reason: 'unsupported_type' };
  }

  await db
    .insert(organisationBranding)
    .values({ orgId, logoMime: input.mime, logoBytes: input.bytes, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: organisationBranding.orgId,
      set: { logoMime: input.mime, logoBytes: input.bytes, updatedAt: new Date() },
    });

  return { ok: true };
}

export async function removeOrgLogo(db: DbLike, orgId: string): Promise<void> {
  await db.delete(organisationBranding).where(eq(organisationBranding.orgId, orgId));
}

export interface OrgLogo {
  mime: string;
  bytes: Buffer;
  updatedAt: Date;
}

/** Reads a logo by organisation slug, for the public logo route. */
export async function getOrgLogoBySlug(db: DbLike, slug: string): Promise<OrgLogo | null> {
  const [row] = await db
    .select({
      mime: organisationBranding.logoMime,
      bytes: organisationBranding.logoBytes,
      updatedAt: organisationBranding.updatedAt,
    })
    .from(organisationBranding)
    .innerJoin(organisations, eq(organisations.id, organisationBranding.orgId))
    .where(eq(organisations.slug, slug))
    .limit(1);

  return row ?? null;
}

/**
 * Whether an organisation has a logo, and when it last changed.
 *
 * Separated from the bytes so a page that only needs to build the `<img src>`
 * does not pull a quarter of a megabyte out of the database to do it. The
 * timestamp becomes a cache-busting token in the URL.
 */
export async function getOrgLogoStamp(db: DbLike, orgId: string): Promise<number | null> {
  const [row] = await db
    .select({ updatedAt: organisationBranding.updatedAt })
    .from(organisationBranding)
    .where(eq(organisationBranding.orgId, orgId))
    .limit(1);

  return row ? row.updatedAt.getTime() : null;
}
