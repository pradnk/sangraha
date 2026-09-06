import { eq, sql } from 'drizzle-orm';
import { analyticsSchemaName, pgIdentifier } from '@sangraha/form-engine';
import type { Database } from '../client';
import type { ObjectDeleter } from '../queries/erasure';
import {
  consentEvents,
  consentNotices,
  forms,
  organisations,
  subjects,
  submissions,
} from '../schema/index';

/**
 * Deletes an organisation and everything belonging to it.
 *
 * The order is not arbitrary, and getting it wrong is why this lives in one
 * place rather than being repeated in the seed and the test harness. Four
 * foreign keys are deliberately ON DELETE RESTRICT:
 *
 *   submissions.form_id        collected data must not disappear because
 *                              someone deleted a form
 *   subjects.subject_type_id   a subject type in use must not be removed
 *   notice_purposes.purpose_id a purpose a published notice names must not
 *                              vanish out from under it
 *   consent_events.notice_..   a notice must not vanish out from under a
 *                              consent that cites its exact words
 *
 * Each is the right rule day to day, and each blocks the organisation cascade
 * until its dependants are gone. So: submissions, subjects, forms, consent
 * events, notices, then the organisation itself.
 *
 * Runs on the owner connection — it is destructive DDL-adjacent work, not
 * something a request should ever be able to trigger.
 *
 * **The bytes go before the rows.** `attachments` cascade from `submissions`,
 * and `attachments.storage_key` is the only record of where the objects live —
 * so deleting the rows first left every photograph and every signature sitting
 * in the bucket permanently, unreachable and unfindable. Destroying an
 * organisation is the one operation where "we no longer hold your data" has to
 * be true of the object store as well.
 *
 * `deleteObject` is injected for the same reason `purgeErasures` injects it:
 * this package runs in migrations, seeds and the analytics generator and must
 * not carry a dependency on how the web app talks to S3. A caller with no
 * storage configured passes nothing, and the count of files that could not be
 * removed comes back rather than being swallowed.
 *
 * One transaction, for two reasons. A half-deleted organisation — submissions
 * gone, people still listed — is a worse state than either end of the
 * operation. And `app.allow_purge` has to be set with `SET LOCAL`, which needs
 * a transaction to be local to: `submission_revisions` is append-only
 * (`sql/015-immutability.sql`) and cascades from `submissions`, so this is one
 * of the two places allowed to destroy it. Saying so explicitly is the point —
 * the guard exists to stop an operator who did not realise, and here we do.
 */
export interface DeleteOrganisationResult {
  /** Objects destroyed in storage. */
  attachmentsDeleted: number;
  /**
   * Objects storage would not let go of, or could not be asked about.
   *
   * Surfaced rather than swallowed, exactly as `purgeErasures` does: an
   * operator who has just told somebody their data is gone needs to know when
   * some of it is not.
   */
  attachmentsFailed: number;
}

export async function deleteOrganisation(
  db: Database,
  orgId: string,
  options: { deleteObject?: ObjectDeleter } = {},
): Promise<DeleteOrganisationResult> {
  const [org] = await db
    .select({ slug: organisations.slug })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!org) return { attachmentsDeleted: 0, attachmentsFailed: 0 };

  /*
   * Before the transaction, and deliberately.
   *
   * Object storage cannot join a Postgres transaction, so one of the two has to
   * go first — and for a deletion it must be the bytes. Rows first and a
   * failure here leaves objects nothing points at; this way round, a failure
   * leaves rows a re-run will find again.
   */
  const files = (await db.execute(sql`
    SELECT storage_key FROM attachments WHERE org_id = ${orgId}
  `)) as unknown as { storage_key: string }[];

  let attachmentsDeleted = 0;
  let attachmentsFailed = 0;
  for (const file of files) {
    // With no deleter configured the bytes are unreachable from here at all,
    // which is a failure to delete and is reported as one.
    const removed = options.deleteObject ? await options.deleteObject(file.storage_key) : false;
    if (removed) attachmentsDeleted += 1;
    else attachmentsFailed += 1;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.allow_purge', 'on', true)`);

    // The organisation's analytics views go with it; they are derived data and
    // would otherwise be left pointing at rows that no longer exist.
    await tx.execute(
      sql.raw(`DROP SCHEMA IF EXISTS ${pgIdentifier(analyticsSchemaName(org.slug))} CASCADE`),
    );

    // submission_revisions and attachments cascade from submissions.
    await tx.delete(submissions).where(eq(submissions.orgId, orgId));
    // subject_relations cascade from subjects.
    await tx.delete(subjects).where(eq(subjects.orgId, orgId));
    // form_versions and form_fields cascade from forms.
    await tx.delete(forms).where(eq(forms.orgId, orgId));
    /*
     * Consent events before the notices they cite.
     *
     * `consent_events.notice_version_id` is ON DELETE RESTRICT — a notice must
     * never be able to vanish out from under a consent that claims those exact
     * words were read. Same reasoning as the two below.
     */
    await tx.delete(consentEvents).where(eq(consentEvents.orgId, orgId));
    /*
     * Notices before purposes. `consent_notice_purposes.purpose_id` is
     * ON DELETE RESTRICT — a purpose named by a published notice must not be
     * able to vanish out from under it — and two cascade paths from
     * `organisations` have no guaranteed order between them. Deleting the
     * notices first frees the purposes, which then cascade with everything
     * else. Same shape as the `forms` ordering above.
     */
    await tx.delete(consentNotices).where(eq(consentNotices.orgId, orgId));
    // Users, locations, option sets and subject types cascade from here.
    await tx.delete(organisations).where(eq(organisations.id, orgId));
  });

  return { attachmentsDeleted, attachmentsFailed };
}

/** Convenience wrapper for scripts that know the slug rather than the id. */
export async function deleteOrganisationBySlug(
  db: Database,
  slug: string,
  options: { deleteObject?: ObjectDeleter } = {},
): Promise<DeleteOrganisationResult> {
  const [org] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, slug))
    .limit(1);
  return org
    ? deleteOrganisation(db, org.id, options)
    : { attachmentsDeleted: 0, attachmentsFailed: 0 };
}
