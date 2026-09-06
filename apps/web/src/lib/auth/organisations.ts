import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { getOwnerDb, organisations } from '@sangraha/db';

export interface SignInOrganisation {
  slug: string;
  name: string;
}

/**
 * Organisations offered on the login screen.
 *
 * Read on the owner connection because there is no tenant context before
 * sign-in — this is the one query that legitimately spans organisations.
 *
 * On a self-hosted install there is exactly one, and the field disappears
 * entirely. A field worker should never be asked to recall a slug they have
 * never seen written down.
 *
 * For multi-tenant SaaS this list should be replaced by subdomain resolution
 * (`shiksha.example.org`) rather than a public dropdown, which would otherwise
 * enumerate every customer. Tracked with the rest of the SaaS work.
 */
export async function listSignInOrganisations(): Promise<SignInOrganisation[]> {
  return getOwnerDb()
    .select({ slug: organisations.slug, name: organisations.name })
    .from(organisations)
    .where(eq(organisations.isActive, true))
    .orderBy(asc(organisations.name));
}
