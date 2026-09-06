import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  composeNotice,
  hashNoticeText,
  localise,
  toSnakeCase,
  type I18nText,
} from '@sangraha/form-engine';
import type { DbLike } from '../client';
import {
  consentNoticePurposes,
  consentNoticeVersions,
  consentNotices,
  purposes,
} from '../schema/compliance';
import { getOrgIdentity, missingForNotice } from './organisation-identity';
import { purposeCoverage, REQUIRES_CONSENT, type LawfulBasis } from './purposes';

/**
 * Authoring privacy notices.
 *
 * The same draft-then-publish shape as `form-builder.ts`, deliberately: a
 * published notice is immutable, editing creates a new version, and a consent
 * event points at the version it was given under. That is what keeps a consent
 * from three years ago interpretable — without it, editing a paragraph
 * retroactively changes what everyone ever agreed to.
 */

export interface NoticeVersionSummary {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published' | 'archived';
  publishedAt: Date | null;
  retractedAt: Date | null;
}

export interface NoticeDetail {
  id: string;
  slug: string;
  name: I18nText;
  currentVersionId: string | null;
  /**
   * The words currently being read out, when a version is live.
   *
   * Carried so an editor has something to show for a published notice with no
   * open draft — `draft` is null in that state, and a screen that fell back to
   * an empty box was reporting that a live notice said nothing.
   */
  publishedBody: I18nText | null;
  draft: {
    id: string;
    versionNumber: number;
    body: I18nText;
    bodyMachine: Record<string, boolean>;
    purposeIds: string[];
  } | null;
  versions: NoticeVersionSummary[];
}

export async function listNotices(db: DbLike, orgId: string): Promise<NoticeDetail[]> {
  const rows = await db
    .select({
      id: consentNotices.id,
      slug: consentNotices.slug,
      name: consentNotices.name,
      currentVersionId: consentNotices.currentVersionId,
    })
    .from(consentNotices)
    .where(eq(consentNotices.orgId, orgId))
    .orderBy(asc(consentNotices.slug));

  return Promise.all(rows.map((row) => hydrate(db, row)));
}

/**
 * Removes a notice nobody has ever been read.
 *
 * Only while `currentVersionId` is null, and that restriction is the whole
 * design. A published version is the evidence of what somebody was told before
 * they agreed — `consent_events` cites it by id and hash — so deleting one would
 * destroy the organisation's own defence. Those are switched off with
 * `isActive` instead, which stops `consentRequirementFor` choosing them while
 * leaving the record intact.
 *
 * Exists because a first attempt at a notice is easy to get wrong: `slug` is
 * derived from the name and immutable, so an administrator who types a sentence
 * where a label belonged, or creates one twice, previously had no way back and
 * was left with permanent clutter on the screen that matters most.
 */
export async function discardNotice(
  db: DbLike,
  orgId: string,
  noticeId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'published' }> {
  const [notice] = await db
    .select({ id: consentNotices.id, currentVersionId: consentNotices.currentVersionId })
    .from(consentNotices)
    .where(and(eq(consentNotices.id, noticeId), eq(consentNotices.orgId, orgId)))
    .limit(1);

  if (!notice) return { ok: false, reason: 'not_found' };
  if (notice.currentVersionId) return { ok: false, reason: 'published' };

  // Versions and their purpose links cascade from the notice row.
  await db.delete(consentNotices).where(eq(consentNotices.id, noticeId));
  return { ok: true };
}

export async function getNotice(
  db: DbLike,
  orgId: string,
  slug: string,
): Promise<NoticeDetail | null> {
  const [row] = await db
    .select({
      id: consentNotices.id,
      slug: consentNotices.slug,
      name: consentNotices.name,
      currentVersionId: consentNotices.currentVersionId,
    })
    .from(consentNotices)
    .where(and(eq(consentNotices.orgId, orgId), eq(consentNotices.slug, slug)))
    .limit(1);

  return row ? hydrate(db, row) : null;
}

async function hydrate(
  db: DbLike,
  row: { id: string; slug: string; name: I18nText; currentVersionId: string | null },
): Promise<NoticeDetail> {
  const versions = await db
    .select({
      id: consentNoticeVersions.id,
      versionNumber: consentNoticeVersions.versionNumber,
      status: consentNoticeVersions.status,
      publishedAt: consentNoticeVersions.publishedAt,
      retractedAt: consentNoticeVersions.retractedAt,
      body: consentNoticeVersions.body,
      bodyMachine: consentNoticeVersions.bodyMachine,
    })
    .from(consentNoticeVersions)
    .where(eq(consentNoticeVersions.noticeId, row.id))
    .orderBy(desc(consentNoticeVersions.versionNumber));

  const open = versions.find((version) => version.status === 'draft');

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    currentVersionId: row.currentVersionId,
    publishedBody:
      versions.find((version) => version.id === row.currentVersionId)?.body ?? null,
    draft: open
      ? {
          id: open.id,
          versionNumber: open.versionNumber,
          body: open.body,
          bodyMachine: open.bodyMachine,
          purposeIds: (
            await db
              .select({ purposeId: consentNoticePurposes.purposeId })
              .from(consentNoticePurposes)
              .where(eq(consentNoticePurposes.noticeVersionId, open.id))
              .orderBy(asc(consentNoticePurposes.sortOrder))
          ).map((entry) => entry.purposeId),
        }
      : null,
    versions: versions.map(({ body: _body, bodyMachine: _machine, ...summary }) => summary),
  };
}

export async function createNotice(
  db: DbLike,
  orgId: string,
  input: { slug?: string; name: I18nText },
): Promise<string> {
  const slug = input.slug?.trim() || toSnakeCase(localise(input.name, 'en', 'notice'));

  const [row] = await db
    .insert(consentNotices)
    .values({ orgId, slug, name: input.name })
    .returning({ id: consentNotices.id });

  return row!.id;
}

/**
 * The open draft, creating one from the published version if there is none.
 *
 * Copy-on-edit, exactly like `getOrCreateDraft` for forms: the published
 * version is never touched, so a worker reading the notice aloud on a phone
 * mid-edit is reading the last published words rather than a half-finished
 * sentence.
 */
export async function getOrCreateNoticeDraft(
  db: DbLike,
  noticeId: string,
  userId: string,
): Promise<string> {
  const [open] = await db
    .select({ id: consentNoticeVersions.id })
    .from(consentNoticeVersions)
    .where(
      and(eq(consentNoticeVersions.noticeId, noticeId), eq(consentNoticeVersions.status, 'draft')),
    )
    .limit(1);
  if (open) return open.id;

  const [latest] = await db
    .select({
      id: consentNoticeVersions.id,
      versionNumber: consentNoticeVersions.versionNumber,
      body: consentNoticeVersions.body,
      bodyMachine: consentNoticeVersions.bodyMachine,
    })
    .from(consentNoticeVersions)
    .where(eq(consentNoticeVersions.noticeId, noticeId))
    .orderBy(desc(consentNoticeVersions.versionNumber))
    .limit(1);

  const [created] = await db
    .insert(consentNoticeVersions)
    .values({
      noticeId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      status: 'draft',
      body: latest?.body ?? {},
      bodyMachine: latest?.bodyMachine ?? {},
      createdBy: userId,
    })
    .returning({ id: consentNoticeVersions.id });

  // Carry the purpose list forward too, or an edit would silently un-cover
  // everything the published version covered.
  if (latest) {
    const carried = await db
      .select({
        purposeId: consentNoticePurposes.purposeId,
        sortOrder: consentNoticePurposes.sortOrder,
      })
      .from(consentNoticePurposes)
      .where(eq(consentNoticePurposes.noticeVersionId, latest.id));

    if (carried.length > 0) {
      await db.insert(consentNoticePurposes).values(
        carried.map((entry) => ({
          noticeVersionId: created!.id,
          purposeId: entry.purposeId,
          sortOrder: entry.sortOrder,
        })),
      );
    }
  }

  return created!.id;
}

export async function updateNoticeDraft(
  db: DbLike,
  versionId: string,
  patch: { body?: I18nText; bodyMachine?: Record<string, boolean> },
): Promise<void> {
  await db
    .update(consentNoticeVersions)
    .set(patch)
    .where(
      and(eq(consentNoticeVersions.id, versionId), eq(consentNoticeVersions.status, 'draft')),
    );
}

export async function setNoticePurposes(
  db: DbLike,
  versionId: string,
  purposeIds: string[],
): Promise<void> {
  await db
    .delete(consentNoticePurposes)
    .where(eq(consentNoticePurposes.noticeVersionId, versionId));

  if (purposeIds.length === 0) return;
  await db.insert(consentNoticePurposes).values(
    purposeIds.map((purposeId, index) => ({
      noticeVersionId: versionId,
      purposeId,
      sortOrder: index,
    })),
  );
}

/**
 * Writes a first draft from what the organisation already collects.
 *
 * Seeds only the languages that are still empty. An administrator who has
 * rewritten the English keeps their English; regenerating after adding a
 * question tops up what is missing rather than discarding their words — the
 * same rule `applyTranslations` follows.
 */
export async function generateNoticeDraft(
  db: DbLike,
  orgId: string,
  versionId: string,
  options: { locale?: string; force?: boolean } = {},
): Promise<{ ok: true; text: string } | { ok: false; missing: string[] }> {
  const locale = options.locale ?? 'en';

  const identity = await getOrgIdentity(db, orgId);
  if (!identity) return { ok: false, missing: ['legalName'] };

  const missing = missingForNotice(identity);
  if (missing.length > 0) return { ok: false, missing };

  const [org] = (await db.execute(
    sql`SELECT name FROM organisations WHERE id = ${orgId} LIMIT 1`,
  )) as unknown as { name: string }[];

  const coverage = await purposeCoverage(db, orgId);
  const bases = new Map(
    (
      await db
        .select({ id: purposes.id, basis: purposes.lawfulBasis })
        .from(purposes)
        .where(eq(purposes.orgId, orgId))
    ).map((row) => [row.id, row.basis as LawfulBasis]),
  );

  const text = composeNotice(
    {
      legalName: identity.legalName,
      name: org?.name ?? '',
      grievanceOfficerName: identity.grievanceOfficerName,
      grievanceOfficerEmail: identity.grievanceOfficerEmail,
      grievanceOfficerPhone: identity.grievanceOfficerPhone,
    },
    coverage
      // Unattributed questions are excluded rather than described as belonging
      // to a purpose nobody chose. `unattributedFields` is what reports them.
      .filter((entry) => entry.purposeId !== null)
      .map((entry) => ({
        name: entry.purposeName ?? {},
        requiresConsent: REQUIRES_CONSENT[bases.get(entry.purposeId!) ?? 'consent'],
        fields: entry.fields,
      })),
    locale,
  );

  const [version] = await db
    .select({ body: consentNoticeVersions.body, status: consentNoticeVersions.status })
    .from(consentNoticeVersions)
    .where(eq(consentNoticeVersions.id, versionId))
    .limit(1);
  if (!version || version.status !== 'draft') return { ok: false, missing: ['draft'] };

  const existing = version.body ?? {};
  const alreadyWritten = (existing[locale] ?? '').trim() !== '';
  if (alreadyWritten && !options.force) return { ok: true, text: existing[locale]! };

  await db
    .update(consentNoticeVersions)
    .set({ body: { ...existing, [locale]: text } })
    .where(eq(consentNoticeVersions.id, versionId));

  return { ok: true, text };
}

export type PublishNoticeResult =
  | { ok: true; versionId: string; versionNumber: number }
  | { ok: false; reason: 'no_draft' | 'empty' | 'no_purposes' | 'organisation_incomplete'; missing?: string[] };

/**
 * Publishes the draft, freezing its words and hashing them.
 *
 * The hash is computed here rather than on the device, so there is a server-side
 * answer to "what did this version say" that a phone can be checked against.
 */
export async function publishNotice(
  db: DbLike,
  orgId: string,
  noticeId: string,
  userId: string,
): Promise<PublishNoticeResult> {
  const identity = await getOrgIdentity(db, orgId);
  const missing = identity ? missingForNotice(identity) : ['legalName'];
  if (missing.length > 0) return { ok: false, reason: 'organisation_incomplete', missing };

  const [draft] = await db
    .select({
      id: consentNoticeVersions.id,
      versionNumber: consentNoticeVersions.versionNumber,
      body: consentNoticeVersions.body,
    })
    .from(consentNoticeVersions)
    .where(
      and(eq(consentNoticeVersions.noticeId, noticeId), eq(consentNoticeVersions.status, 'draft')),
    )
    .limit(1);
  if (!draft) return { ok: false, reason: 'no_draft' };

  const written = Object.entries(draft.body ?? {}).filter(([, text]) => (text ?? '').trim() !== '');
  if (written.length === 0) return { ok: false, reason: 'empty' };

  const [covered] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(consentNoticePurposes)
    .where(eq(consentNoticePurposes.noticeVersionId, draft.id));
  // A notice covering nothing cannot be consented to: the consent event points
  // at a purpose, and there would be none to point at.
  if (Number(covered?.count ?? 0) === 0) return { ok: false, reason: 'no_purposes' };

  const hashes: Record<string, string> = {};
  for (const [locale, text] of written) hashes[locale] = await hashNoticeText(text!);

  await db
    .update(consentNoticeVersions)
    .set({
      status: 'published',
      publishedAt: new Date(),
      publishedBy: userId,
      bodySha256: hashes,
    })
    .where(eq(consentNoticeVersions.id, draft.id));

  await db
    .update(consentNotices)
    .set({ currentVersionId: draft.id, updatedAt: new Date() })
    .where(eq(consentNotices.id, noticeId));

  return { ok: true, versionId: draft.id, versionNumber: draft.versionNumber };
}

/**
 * Marks a published notice as inadequate.
 *
 * Consent taken under it stays valid — it is what happened, and pretending
 * otherwise would falsify the record. What this buys is the ability to say "N
 * people consented under a notice we have since retracted", which is the only
 * way to target re-consent at the people who need it.
 */
export async function retractNoticeVersion(db: DbLike, versionId: string): Promise<void> {
  await db
    .update(consentNoticeVersions)
    .set({ retractedAt: new Date() })
    .where(eq(consentNoticeVersions.id, versionId));
}

export interface PublishedNotice {
  versionId: string;
  versionNumber: number;
  body: I18nText;
  bodySha256: Record<string, string>;
  purposeIds: string[];
  retractedAt: Date | null;
}

/** The version a field worker should be reading out right now. */
export async function currentNotice(
  db: DbLike,
  orgId: string,
  slug: string,
): Promise<PublishedNotice | null> {
  const [row] = await db
    .select({
      versionId: consentNoticeVersions.id,
      versionNumber: consentNoticeVersions.versionNumber,
      body: consentNoticeVersions.body,
      bodySha256: consentNoticeVersions.bodySha256,
      retractedAt: consentNoticeVersions.retractedAt,
    })
    .from(consentNotices)
    .innerJoin(
      consentNoticeVersions,
      eq(consentNoticeVersions.id, consentNotices.currentVersionId),
    )
    .where(and(eq(consentNotices.orgId, orgId), eq(consentNotices.slug, slug)))
    .limit(1);

  if (!row) return null;

  const covered = await db
    .select({ purposeId: consentNoticePurposes.purposeId })
    .from(consentNoticePurposes)
    .where(eq(consentNoticePurposes.noticeVersionId, row.versionId))
    .orderBy(asc(consentNoticePurposes.sortOrder));

  return { ...row, purposeIds: covered.map((entry) => entry.purposeId) };
}
