import 'server-only';
import { eq } from 'drizzle-orm';
import { getOrgLogoStamp, getOwnerDb, organisations } from '@sangraha/db';
import type { OrgIdentity } from '@/components/brand/org-brand';

/**
 * The organisation's name and logo stamp, for the header.
 *
 * Reads on the owner connection and by slug, because the login screen needs it
 * before there is any session to scope by. Only the name and a timestamp — the
 * logo bytes are fetched separately by the browser and cached.
 */
export async function getOrgIdentityBySlug(slug: string): Promise<OrgIdentity | null> {
  const db = getOwnerDb();

  const [org] = await db
    .select({ id: organisations.id, name: organisations.name, slug: organisations.slug })
    .from(organisations)
    .where(eq(organisations.slug, slug))
    .limit(1);
  if (!org) return null;

  return { name: org.name, slug: org.slug, logoStamp: await getOrgLogoStamp(db, org.id) };
}

export async function getOrgIdentityById(orgId: string): Promise<OrgIdentity | null> {
  const db = getOwnerDb();

  const [org] = await db
    .select({ name: organisations.name, slug: organisations.slug })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!org) return null;

  return { name: org.name, slug: org.slug, logoStamp: await getOrgLogoStamp(db, orgId) };
}
