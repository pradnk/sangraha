import { customType, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './tenancy';

/** Raw bytes. Postgres `bytea`, surfaced as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * An organisation's logo.
 *
 * Its own table so the bytes are never dragged along by an ordinary
 * `select … from organisations`, which happens on nearly every request.
 *
 * Stored in Postgres rather than object storage, deliberately. A logo is one
 * small file per tenant that has to be readable *before* anyone signs in — it
 * is on the login screen — which with S3 would mean either a public bucket or a
 * presigning round trip on every page load. Submission attachments are a
 * different problem entirely (millions of files, megabytes each) and belong in
 * S3; this does not.
 */
export const organisationBranding = pgTable('organisation_branding', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organisations.id, { onDelete: 'cascade' }),
  logoMime: text('logo_mime').notNull(),
  logoBytes: bytea('logo_bytes').notNull(),
  /** Used as a cache-busting token in the logo URL. */
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
