import { createHmac } from 'node:crypto';
import { authSecret } from '../auth/secret';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbLike } from '../client';
import { consentEvents } from '../schema/consent';
import { consentNoticeVersions, purposes } from '../schema/compliance';
import { resolveMinorStatus, type I18nText } from '@sangraha/form-engine';
import { REQUIRES_CONSENT, type LawfulBasis } from './purposes';

/**
 * Recording and reading consent.
 *
 * One writer, `recordConsentEvents`, shared by the submissions endpoint and the
 * standalone consent endpoint — the same two-entry-points-one-rule-set shape as
 * `reviewSubmission` / `approveSubmissions`. Two writers would mean two places
 * that could forget the clamp, the lock or the pseudonym.
 *
 * Current state is a query rather than a view, deliberately. A view created by
 * the owner and read by `mis_app` bypasses every RLS policy — the trap already
 * documented in `records.ts`. The analytics screens get away with that because
 * they are admin-only; consent is read by a field worker at capture time, so
 * that escape hatch is unavailable.
 */

export type ConsentAction = 'given' | 'withdrawn' | 'refused' | 'asserted';
export type MinorBasis = 'dob' | 'age_field' | 'worker_declared' | 'unknown';

export interface ConsentEventInput {
  /** Generated on the device when the worker tapped, not when it sent. */
  clientEventUuid: string;
  subjectId: string;
  purposeId: string;
  action: ConsentAction;
  lawfulBasis: LawfulBasis;
  noticeVersionId?: string | null;
  noticeLocale?: string | null;
  noticeTextSha256?: string | null;
  noticeSecondsShown?: number | null;
  noticeReadAloud?: boolean | null;
  clientOccurredAt?: Date | string | null;
  validUntil?: Date | null;

  subjectIsMinor?: boolean | null;
  minorBasis?: MinorBasis | null;
  guardianName?: string | null;
  guardianRelationship?: string | null;
  guardianContact?: string | null;
  guardianEvidenceSeen?: string | null;
  guardianVerified?: boolean | null;
  pendingOverride?: boolean;
}

export interface ConsentActor {
  orgId: string;
  userId: string;
  role?: string | null;
}

/**
 * A stable, non-reversing handle on a person that survives their erasure.
 *
 * Keyed on the organisation so the same subject id in two tenants does not
 * produce the same pseudonym, which would leak the fact that a record was
 * copied between them.
 *
 * The pepper comes from `AUTH_SECRET` rather than a column: a pepper stored
 * beside the data it protects is decoration. Note honestly what this buys —
 * while the organisation still holds the subject id it can recompute the HMAC
 * and re-identify, so this is pseudonymisation. It becomes anonymisation only
 * once the subject row itself is destroyed.
 */
export function subjectPseudonym(orgId: string, subjectId: string): string {
  // The same validation the session signer uses. This used to accept anything
  // non-empty, which meant a pepper could be weaker than the key signing
  // cookies while both came from the one variable.
  return createHmac('sha256', authSecret()).update(`${orgId}:${subjectId}`).digest('hex');
}

/**
 * Appends consent events.
 *
 * Three things happen here that must not be re-implemented anywhere else:
 *
 * **The device clock is not trusted for ordering.** `occurred_at` is clamped to
 * no later than now. A withdrawal from a phone three days slow would otherwise
 * lose to an older "given", and the system would go on collecting data it had
 * been told to stop collecting — silently.
 *
 * **A lock per (subject, purpose).** Without it a withdrawal arriving
 * concurrently with a submission loses the race the same way.
 *
 * **Replays are idempotent, but a changed replay is an error.** The unique index
 * makes the first free; `onConflictDoNothing` would make the second invisible,
 * and a client sending different content under the same id is a bug or
 * tampering, not a retry.
 */
/**
 * Whether the words shown on the device were the words we published.
 *
 * `notice_mismatch` existed as a column, was rendered as a warning on the
 * consent record and counted on the privacy dashboard — and nothing ever wrote
 * it. `recordConsentEvents` stored the client's hash verbatim and never
 * compared it to anything, so the figure was permanently zero and the warning
 * permanently false. A phone rendering a stale cached notice — the exact
 * scenario `schema/compliance.ts` says this exists to catch — was undetectable.
 *
 * Compared per locale, because `body_sha256` is a map: the same version says
 * different words in Kannada and in Hindi, and the one that matters is the one
 * the person was actually read.
 *
 * Absent evidence is not a mismatch. A client that sends no hash (an insecure
 * origin has no SubtleCrypto), a notice with no published hash for that locale,
 * or an event citing no version at all, all leave this false — the column means
 * "we checked and they differed", never "we could not check".
 */
async function noticeTextDiffers(
  db: DbLike,
  event: ConsentEventInput,
  published: Map<string, Record<string, string>>,
): Promise<boolean> {
  const supplied = event.noticeTextSha256;
  if (!supplied || !event.noticeVersionId || !event.noticeLocale) return false;

  let hashes = published.get(event.noticeVersionId);
  if (!hashes) {
    const [row] = await db
      .select({ bodySha256: consentNoticeVersions.bodySha256 })
      .from(consentNoticeVersions)
      .where(eq(consentNoticeVersions.id, event.noticeVersionId))
      .limit(1);
    hashes = row?.bodySha256 ?? {};
    published.set(event.noticeVersionId, hashes);
  }

  const expected = hashes[event.noticeLocale];
  return expected ? expected !== supplied : false;
}

export async function recordConsentEvents(
  db: DbLike,
  actor: ConsentActor,
  events: ConsentEventInput[],
): Promise<{ written: number; replayed: number }> {
  let written = 0;
  let replayed = 0;
  // One lookup per notice version rather than per event: a submission carries
  // an event per purpose and they all cite the same notice.
  const publishedHashes = new Map<string, Record<string, string>>();

  for (const event of events) {
    // Serialise per person and purpose, so "read the latest, then append"
    // cannot interleave with another writer doing the same.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${event.subjectId}:${event.purposeId}`}))`,
    );

    const [existing] = await db
      .select({ id: consentEvents.id, action: consentEvents.action, purposeId: consentEvents.purposeId })
      .from(consentEvents)
      .where(
        and(
          eq(consentEvents.orgId, actor.orgId),
          eq(consentEvents.clientEventUuid, event.clientEventUuid),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.action !== event.action || existing.purposeId !== event.purposeId) {
        throw new ConsentConflictError(event.clientEventUuid);
      }
      replayed += 1;
      continue;
    }

    const claimed = event.clientOccurredAt ? new Date(event.clientOccurredAt) : null;
    const now = new Date();
    const occurredAt = claimed && !Number.isNaN(claimed.getTime()) && claimed < now ? claimed : now;

    await db.insert(consentEvents).values({
      orgId: actor.orgId,
      clientEventUuid: event.clientEventUuid,
      subjectId: event.subjectId,
      subjectPseudonym: subjectPseudonym(actor.orgId, event.subjectId),
      purposeId: event.purposeId,
      noticeVersionId: event.noticeVersionId ?? null,
      action: event.action,
      lawfulBasis: event.lawfulBasis,
      clientOccurredAt: claimed,
      occurredAt,
      validUntil: event.validUntil ?? null,
      noticeLocale: event.noticeLocale ?? null,
      noticeTextSha256: event.noticeTextSha256 ?? null,
      noticeMismatch: await noticeTextDiffers(db, event, publishedHashes),
      noticeSecondsShown: event.noticeSecondsShown ?? null,
      noticeReadAloud: event.noticeReadAloud ?? null,
      attestedBy: actor.userId,
      attestedRole: actor.role ?? null,
      subjectIsMinor: event.subjectIsMinor ?? null,
      minorBasis: event.minorBasis ?? null,
      guardianName: event.guardianName ?? null,
      guardianRelationship: event.guardianRelationship ?? null,
      guardianContact: event.guardianContact ?? null,
      guardianEvidenceSeen: event.guardianEvidenceSeen ?? null,
      guardianVerified: event.guardianVerified ?? null,
      pendingOverride: event.pendingOverride ?? false,
    });
    written += 1;
  }

  return { written, replayed };
}

/** The same idempotency key arriving with different content. */
export class ConsentConflictError extends Error {
  constructor(readonly clientEventUuid: string) {
    super(`Consent event ${clientEventUuid} was already recorded with different content`);
    this.name = 'ConsentConflictError';
  }
}

export interface ConsentState {
  purposeId: string;
  purposeCode: string;
  action: ConsentAction;
  lawfulBasis: LawfulBasis;
  occurredAt: Date;
  validUntil: Date | null;
  noticeVersionId: string | null;
  subjectIsMinor: boolean | null;
  guardianVerified: boolean | null;
  pendingOverride: boolean;
  /** True when the latest event still stands: given or asserted, and unexpired. */
  isActive: boolean;
}

/**
 * What currently stands for one person, per purpose.
 *
 * The latest event wins, and expiry is *derived* from `valid_until` rather than
 * being an event of its own. There is no job runner in this system, so an
 * expiry that has to be fired never happens on a self-hosted box nobody has
 * scheduled anything on — whereas this is correct on every deployment the
 * instant the clock passes.
 */
export async function consentStateFor(
  db: DbLike,
  orgId: string,
  subjectId: string,
): Promise<ConsentState[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (e.org_id, e.subject_id, e.purpose_id)
      e.purpose_id, p.code AS purpose_code, e.action::text AS action,
      e.lawful_basis::text AS lawful_basis, e.occurred_at, e.valid_until,
      e.notice_version_id, e.subject_is_minor, e.guardian_verified, e.pending_override
    FROM consent_events e
    JOIN purposes p ON p.id = e.purpose_id
    WHERE e.org_id = ${orgId} AND e.subject_id = ${subjectId}::uuid
    ORDER BY e.org_id, e.subject_id, e.purpose_id, e.occurred_at DESC, e.seq DESC
  `)) as unknown as Record<string, unknown>[];

  const now = Date.now();

  return rows.map((row) => {
    const action = row.action as ConsentAction;
    const validUntil = row.valid_until ? new Date(row.valid_until as string) : null;

    return {
      purposeId: row.purpose_id as string,
      purposeCode: row.purpose_code as string,
      action,
      lawfulBasis: row.lawful_basis as LawfulBasis,
      occurredAt: new Date(row.occurred_at as string),
      validUntil,
      noticeVersionId: (row.notice_version_id as string) ?? null,
      subjectIsMinor: (row.subject_is_minor as boolean) ?? null,
      guardianVerified: (row.guardian_verified as boolean) ?? null,
      pendingOverride: Boolean(row.pending_override),
      isActive:
        (action === 'given' || action === 'asserted') &&
        (validUntil === null || validUntil.getTime() > now),
    };
  });
}

/**
 * Whether any question on this form version rests on somebody's permission.
 *
 * Lets a reviewer be told the difference between "nobody was asked, and nobody
 * needed to be" and "nobody was asked, and somebody should have been". Without
 * it an absent consent record looks identical in both cases, and a warning shown
 * on every legitimate-use form is a warning nobody reads.
 *
 * Reads the basis off the purpose rather than assuming, the same way
 * `consentRequirementFor` does.
 */
export async function formNeedsConsent(
  db: DbLike,
  orgId: string,
  formVersionId: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM form_fields ff
    JOIN purposes p ON p.id = ff.purpose_id
    WHERE ff.form_version_id = ${formVersionId}::uuid
      AND p.org_id = ${orgId}
      AND p.is_active
      AND p.lawful_basis IN ('consent', 'guardian_consent')
    LIMIT 1
  `)) as unknown as unknown[];

  return rows.length > 0;
}

export interface ConsentRecord {
  eventId: string;
  purposeId: string;
  purposeName: I18nText;
  purposeCode: string;
  action: ConsentAction;
  occurredAt: Date;
  /** Which published wording they were read, when one was cited. */
  noticeVersionNumber: number | null;
  noticeLocale: string | null;
  /** True when the phone's claim about the wording did not match the server's. */
  noticeMismatch: boolean;
  noticeReadAloud: boolean | null;
  noticeSecondsShown: number | null;
  subjectIsMinor: boolean | null;
  minorBasis: MinorBasis | null;
  guardianName: string | null;
  guardianRelationship: string | null;
  guardianVerified: boolean | null;
  pendingOverride: boolean;
  overrideReason: string | null;
  overrideAt: Date | null;
}

/**
 * The attestation behind one person's record, for whoever is reviewing it.
 *
 * `consentStateFor` answers "may we still use this", which is what the capture
 * path needs. A supervisor deciding whether to approve a record is asking
 * something different and more human: was this person actually asked, were they
 * read the words, and if they are a child, who agreed on their behalf. Those
 * columns exist on every event and nothing was reading them back.
 *
 * Latest event per purpose, same rule as `consentStateFor` — a withdrawal
 * supersedes the consent before it, and a reviewer must see the withdrawal.
 */
export async function consentRecordFor(
  db: DbLike,
  orgId: string,
  subjectId: string,
): Promise<ConsentRecord[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (e.purpose_id)
      e.id, e.purpose_id, p.name AS purpose_name, p.code AS purpose_code,
      e.action::text AS action, e.occurred_at,
      v.version_number AS notice_version_number,
      e.notice_locale, e.notice_mismatch, e.notice_read_aloud, e.notice_seconds_shown,
      e.subject_is_minor, e.minor_basis::text AS minor_basis,
      e.guardian_name, e.guardian_relationship, e.guardian_verified,
      e.pending_override, e.override_reason, e.override_at
    FROM consent_events e
    JOIN purposes p ON p.id = e.purpose_id
    LEFT JOIN consent_notice_versions v ON v.id = e.notice_version_id
    WHERE e.org_id = ${orgId}
      AND e.subject_id = ${subjectId}::uuid
      AND e.redacted_at IS NULL
    ORDER BY e.purpose_id, e.occurred_at DESC, e.seq DESC
  `)) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    eventId: row.id as string,
    purposeId: row.purpose_id as string,
    purposeName: (row.purpose_name ?? {}) as I18nText,
    purposeCode: row.purpose_code as string,
    action: row.action as ConsentAction,
    occurredAt: new Date(row.occurred_at as string),
    noticeVersionNumber:
      row.notice_version_number == null ? null : Number(row.notice_version_number),
    noticeLocale: (row.notice_locale as string) ?? null,
    noticeMismatch: Boolean(row.notice_mismatch),
    noticeReadAloud: (row.notice_read_aloud as boolean) ?? null,
    noticeSecondsShown:
      row.notice_seconds_shown == null ? null : Number(row.notice_seconds_shown),
    subjectIsMinor: (row.subject_is_minor as boolean) ?? null,
    minorBasis: (row.minor_basis as MinorBasis) ?? null,
    guardianName: (row.guardian_name as string) ?? null,
    guardianRelationship: (row.guardian_relationship as string) ?? null,
    guardianVerified: (row.guardian_verified as boolean) ?? null,
    pendingOverride: Boolean(row.pending_override),
    overrideReason: (row.override_reason as string) ?? null,
    overrideAt: row.override_at ? new Date(row.override_at as string) : null,
  }));
}

/**
 * Whether data may be collected about this person for this purpose right now.
 *
 * Fails closed: no record at all is not permission. A purpose resting on a
 * Section 7 legitimate use needs no consent, so it is permitted without one —
 * but only after the organisation has said so by choosing that basis, which is
 * why the basis is read from the purpose rather than assumed.
 */
export async function mayCollect(
  db: DbLike,
  orgId: string,
  subjectId: string,
  purposeId: string,
): Promise<{ allowed: boolean; reason: 'consented' | 'legitimate_use' | 'withdrawn' | 'never_asked' }> {
  const [purpose] = await db
    .select({ lawfulBasis: purposes.lawfulBasis })
    .from(purposes)
    .where(and(eq(purposes.id, purposeId), eq(purposes.orgId, orgId)))
    .limit(1);

  if (purpose && !REQUIRES_CONSENT[purpose.lawfulBasis as LawfulBasis]) {
    return { allowed: true, reason: 'legitimate_use' };
  }

  const state = (await consentStateFor(db, orgId, subjectId)).find(
    (entry) => entry.purposeId === purposeId,
  );

  if (!state) return { allowed: false, reason: 'never_asked' };
  if (state.isActive) return { allowed: true, reason: 'consented' };
  return { allowed: false, reason: 'withdrawn' };
}

export interface PendingOverride {
  eventId: string;
  subjectId: string | null;
  purposeCode: string;
  occurredAt: Date;
  attestedBy: string | null;
  guardianName: string | null;
  minorBasis: MinorBasis | null;
}

/**
 * Children recorded without a verified guardian, waiting on a supervisor.
 *
 * Asynchronous because a supervisor is not standing in the village. The worker
 * records what happened and moves on; the decision lands in the same queue as
 * everything else they review.
 */
export async function pendingOverrides(db: DbLike, orgId: string): Promise<PendingOverride[]> {
  const rows = await db
    .select({
      eventId: consentEvents.id,
      subjectId: consentEvents.subjectId,
      purposeCode: purposes.code,
      occurredAt: consentEvents.occurredAt,
      attestedBy: consentEvents.attestedBy,
      guardianName: consentEvents.guardianName,
      minorBasis: consentEvents.minorBasis,
    })
    .from(consentEvents)
    .innerJoin(purposes, eq(purposes.id, consentEvents.purposeId))
    .where(
      and(
        eq(consentEvents.orgId, orgId),
        eq(consentEvents.pendingOverride, true),
        // An erased person's override is not something a supervisor can still
        // decide, and leaving it in the queue makes the queue undrainable.
        isNull(consentEvents.redactedAt),
      ),
    )
    .orderBy(desc(consentEvents.occurredAt));

  return rows as PendingOverride[];
}

/**
 * Whether this caller can see the person an override belongs to.
 *
 * The decision itself has to run on the owner connection — `consent_events` is
 * append-only and only the immutability trigger's declared exception may write
 * to it — so Row-Level Security is not scoping that statement. This check runs
 * first, on the caller's own connection, and refuses before anything privileged
 * happens. Without it a supervisor who guessed an event id could clear a flag on
 * a child in a district they have no business seeing.
 *
 * The join to `subjects` is what does the work, and that is deliberate rather
 * than incidental: `consent_events_read` is org-scoped only
 * (`org_id = app.current_org_id()`), while `subjects_isolation` adds
 * `app.can_see_location(location_id)`. So reaching the event *through* its
 * subject is the only way to inherit the location boundary a supervisor is
 * confined to.
 */
export async function isOverrideVisible(
  db: DbLike,
  orgId: string,
  eventId: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1
    FROM consent_events e
    LEFT JOIN subjects s ON s.id = e.subject_id
    WHERE e.id = ${eventId}::uuid
      AND e.org_id = ${orgId}
      AND e.pending_override
      AND e.redacted_at IS NULL
      -- A consent recorded before its subject existed has no row to scope by;
      -- the event's own policy is what governs it.
      AND (e.subject_id IS NULL OR s.id IS NOT NULL)
    LIMIT 1
  `)) as unknown as unknown[];

  return rows.length > 0;
}

/**
 * A supervisor deciding on a child recorded without a guardian.
 *
 * Note what this does *not* do: it never sets `guardian_verified` to true. An
 * approval says a supervisor accepted the gap and gave a reason — it does not
 * conjure a guardian who was never there. The row stays visibly irregular,
 * which is the entire point; an override that made a record look clean would
 * be a permission rather than an exception.
 *
 * This is the one write to an existing row, so it goes through the owner
 * connection with `app.allow_purge` set — the guard in `015-immutability.sql`
 * otherwise refuses every update but a redaction.
 */
export async function decideOverride(
  db: DbLike,
  eventId: string,
  decision: { by: string; role: string; reason: string },
): Promise<void> {
  await db.execute(sql`SELECT set_config('app.allow_purge', 'on', true)`);
  await db
    .update(consentEvents)
    .set({
      pendingOverride: false,
      overrideBy: decision.by,
      overrideRole: decision.role,
      overrideReason: decision.reason,
      overrideAt: new Date(),
    })
    .where(eq(consentEvents.id, eventId));
}

export interface ConsentSummary {
  peopleWithConsent: number;
  peopleWithoutConsent: number;
  childrenWithoutGuardian: number;
  overridesPending: number;
  noticeMismatches: number;
  /** Median seconds the notice was on screen. The training signal. */
  medianSecondsShown: number | null;
}

/** The compliance dashboard, in one query per figure that needs one. */
export async function consentSummary(db: DbLike, orgId: string): Promise<ConsentSummary> {
  const [row] = (await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (e.org_id, e.subject_id, e.purpose_id)
        e.subject_id, e.action, e.valid_until, e.subject_is_minor,
        e.guardian_verified, e.pending_override, e.notice_mismatch, e.notice_seconds_shown
      FROM consent_events e
      WHERE e.org_id = ${orgId}
        -- Erased people are excluded. Their rows stay in the log as proof of
        -- what happened, but this is a live compliance dashboard: counting
        -- somebody who has been forgotten as "a child with no guardian" is a
        -- problem nobody can act on, and it never goes away.
        AND e.redacted_at IS NULL
      ORDER BY e.org_id, e.subject_id, e.purpose_id, e.occurred_at DESC, e.seq DESC
    )
    SELECT
      count(DISTINCT subject_id) FILTER (
        WHERE action IN ('given', 'asserted')
          AND (valid_until IS NULL OR valid_until > now())
      )::int AS with_consent,
      count(DISTINCT subject_id) FILTER (WHERE action IN ('withdrawn', 'refused'))::int AS without_consent,
      -- DISTINCT, like the two above. The CTE holds one row per (subject,
      -- purpose), so a plain count multiplied every figure by however many
      -- purposes the organisation's notice happens to cover: one child under a
      -- three-purpose notice read as "Children with no guardian: 3".
      count(DISTINCT subject_id) FILTER (
        WHERE subject_is_minor AND guardian_verified IS NOT TRUE
      )::int AS children_no_guardian,
      count(DISTINCT subject_id) FILTER (WHERE pending_override)::int AS overrides_pending,
      count(*) FILTER (WHERE notice_mismatch)::int AS mismatches,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY notice_seconds_shown) AS median_seconds
    FROM latest
  `)) as unknown as Record<string, unknown>[];

  return {
    peopleWithConsent: Number(row?.with_consent ?? 0),
    peopleWithoutConsent: Number(row?.without_consent ?? 0),
    childrenWithoutGuardian: Number(row?.children_no_guardian ?? 0),
    overridesPending: Number(row?.overrides_pending ?? 0),
    noticeMismatches: Number(row?.mismatches ?? 0),
    medianSecondsShown: row?.median_seconds == null ? null : Number(row.median_seconds),
  };
}

export interface ConsentRequirement {
  noticeVersionId: string;
  noticeText: string;
  noticeLocale: string;
  noticeSha256: string | null;
  organisationName: string;
  purposeIds: string[];
  isMinor: boolean | null;
  minorBasis: MinorBasis;
}

/**
 * What has to be asked before this form is filled in.
 *
 * Null when there is nothing to ask, which is a real and common answer: the
 * organisation has not published a notice yet, or every purpose this form
 * serves rests on a Section 7 legitimate use. Asking for consent that is not
 * required is not harmless — it implies a withdrawal the organisation cannot
 * honour, and teaches workers that the question is a formality.
 *
 * The notice chosen is the published one covering the most of what this form
 * needs. An organisation with a single notice — which is nearly all of them —
 * gets that one; an organisation with several gets the one that explains the
 * most, rather than an arbitrary first row.
 */
export async function consentRequirementFor(
  db: DbLike,
  orgId: string,
  formVersionId: string,
  options: { locale?: string; subjectId?: string | null } = {},
): Promise<ConsentRequirement | null> {
  const locale = options.locale ?? 'en';

  const needed = (await db.execute(sql`
    SELECT DISTINCT p.id
    FROM form_fields ff
    JOIN purposes p ON p.id = ff.purpose_id
    WHERE ff.form_version_id = ${formVersionId}::uuid
      AND p.org_id = ${orgId}
      AND p.is_active
      AND p.lawful_basis IN ('consent', 'guardian_consent')
  `)) as unknown as { id: string }[];

  if (needed.length === 0) return null;
  const wanted = new Set(needed.map((row) => row.id));

  const candidates = (await db.execute(sql`
    SELECT
      v.id, v.body, v.body_sha256,
      array_agg(np.purpose_id) AS purpose_ids,
      o.name AS org_name,
      coalesce(o.legal_name, o.name) AS org_legal_name
    FROM consent_notices n
    JOIN consent_notice_versions v ON v.id = n.current_version_id
    JOIN consent_notice_purposes np ON np.notice_version_id = v.id
    JOIN organisations o ON o.id = n.org_id
    WHERE n.org_id = ${orgId} AND n.is_active
    GROUP BY v.id, v.body, v.body_sha256, o.name, o.legal_name
  `)) as unknown as Record<string, unknown>[];

  let best: { row: Record<string, unknown>; covered: string[] } | null = null;
  for (const row of candidates) {
    const covered = (row.purpose_ids as string[]).filter((id) => wanted.has(id));
    if (covered.length === 0) continue;
    if (!best || covered.length > best.covered.length) best = { row, covered };
  }

  // No published notice explains any of this. The screen says so rather than
  // showing a blank one — an empty notice read aloud is not informed consent.
  if (!best) return null;

  const body = (best.row.body ?? {}) as Record<string, string>;
  const hashes = (best.row.body_sha256 ?? {}) as Record<string, string>;
  /*
   * The person's language if the notice has it, else English, else whatever
   * exists. Section 5(3) is about their option, and the honest fallback is the
   * language that was actually written rather than a blank screen.
   */
  const chosen = body[locale]?.trim() ? locale : body.en?.trim() ? 'en' : Object.keys(body)[0];
  if (!chosen || !body[chosen]?.trim()) return null;

  const minor = options.subjectId
    ? await minorStatusOf(db, orgId, options.subjectId)
    : { isMinor: null as boolean | null, basis: 'unknown' as MinorBasis };

  return {
    noticeVersionId: best.row.id as string,
    noticeText: body[chosen],
    noticeLocale: chosen,
    noticeSha256: hashes[chosen] ?? null,
    organisationName: (best.row.org_legal_name as string) ?? (best.row.org_name as string),
    purposeIds: best.covered,
    isMinor: minor.isMinor,
    minorBasis: minor.basis,
  };
}

/**
 * Whether an already-registered person is a child, from what is on file.
 *
 * Reads the nominations on their subject type rather than guessing at key
 * names. An organisation that has nominated nothing gets `unknown`, and the
 * consent screen asks the worker directly — which is the correct behaviour, not
 * a degraded one.
 */
export async function minorStatusOf(
  db: DbLike,
  orgId: string,
  subjectId: string,
): Promise<{ isMinor: boolean | null; basis: MinorBasis; ageYears: number | null }> {
  const [row] = (await db.execute(sql`
    SELECT s.attributes, st.date_of_birth_field, st.age_years_field
    FROM subjects s
    JOIN subject_types st ON st.id = s.subject_type_id
    WHERE s.id = ${subjectId}::uuid AND s.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as Record<string, unknown>[];

  if (!row) return { isMinor: null, basis: 'unknown', ageYears: null };

  const status = resolveMinorStatus(
    {
      dateOfBirthField: (row.date_of_birth_field as string) ?? null,
      ageYearsField: (row.age_years_field as string) ?? null,
    },
    (row.attributes ?? {}) as Record<string, unknown>,
  );

  return { isMinor: status.isMinor, basis: status.basis, ageYears: status.ageYears };
}
