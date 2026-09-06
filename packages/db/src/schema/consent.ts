import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  consentActionEnum,
  erasureModeEnum,
  erasureStatusEnum,
  lawfulBasisEnum,
  minorBasisEnum,
} from './enums';
import { createdAt, primaryId, updatedAt } from './_shared';
import { organisations, users } from './tenancy';
import { consentNoticeVersions, purposes } from './compliance';
import { subjects } from './data';

/*
 * A leaf module, on purpose.
 *
 * `config.ts` needs `purposes` (a form field points at one) and this table
 * needs `subjects` — but `data.ts` needs `config.ts`. Keeping the consent log
 * separate from the purposes and notices it references is what stops that
 * becoming a cycle: compliance depends only on tenancy, and this file, which
 * nothing imports, is free to depend on everything.
 */
/**
 * Every consent, withdrawal and refusal, in the order they happened.
 *
 * **Append-only. Never a flag on the person.** A boolean can say whether you
 * have consent; it cannot say what somebody was told, in which language, by
 * whom, on what date, under which version of your notice — which is the only
 * question that matters when the Board or a funder asks three years later.
 *
 * Withdrawal is a new row, not an edit. The earlier consent stays true, because
 * it *was* the lawful basis for processing that already happened; rewriting it
 * would make the record of that processing a lie.
 *
 * Current state is derived by taking the latest row per (subject, purpose) —
 * see `queries/consent.ts`. Deliberately a query function rather than a view:
 * a view created by the owner and read by `mis_app` bypasses every RLS policy,
 * which the analytics views get away with only because they are admin-only.
 * Consent is read by a field worker at capture time.
 */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),

    /**
     * Generated on the device the moment the worker taps, not when the queue
     * sends. If the app dies and the worker attests again, two attestations
     * genuinely happened and the log should say so.
     */
    clientEventUuid: uuid('client_event_uuid').notNull(),

    /**
     * Nullable, and nulled on erasure rather than deleted.
     *
     * The log is the proof you had consent, and it names the person you have
     * been asked to forget. Redaction resolves that: the row still says a
     * person consented to this purpose under notice version 3 read in Kannada,
     * and names nobody.
     */
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
    /**
     * HMAC of the subject id under a per-organisation pepper.
     *
     * Survives redaction, so consents can still be counted and correlated after
     * the person is gone. Honest about what it is: while the organisation still
     * holds the subject id this is pseudonymisation, not anonymisation. It
     * becomes the latter only once the subject row is destroyed.
     */
    subjectPseudonym: text('subject_pseudonym').notNull(),

    purposeId: uuid('purpose_id')
      .notNull()
      .references(() => purposes.id, { onDelete: 'restrict' }),

    /**
     * The exact words shown. RESTRICT, so a notice can never be deleted out
     * from under a consent that cites it.
     *
     * Nullable only for a legitimate use, which has no notice to cite — the
     * CHECK constraint in the migration enforces that pairing, so "consent
     * always names the words shown" is a property of the database rather than
     * of the code that happens to write to it.
     */
    noticeVersionId: uuid('notice_version_id').references(() => consentNoticeVersions.id, {
      onDelete: 'restrict',
    }),

    action: consentActionEnum('action').notNull(),
    lawfulBasis: lawfulBasisEnum('lawful_basis').notNull(),

    /**
     * When it happened, as the device claimed and as the server will believe.
     *
     * A device clock decides which event wins. A withdrawal captured on a phone
     * three days slow would lose to an older "given", and the log would report
     * consent that no longer exists — silently. So `occurred_at` is clamped to
     * no later than the moment it arrived, and the raw claim is kept beside it
     * for the audit.
     */
    clientOccurredAt: timestamp('client_occurred_at', { withTimezone: true, mode: 'date' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /**
     * Tie-break for two events in the same millisecond, which would otherwise
     * pick a winner non-deterministically. Doubles as a watermark for
     * incremental export.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),

    /** Derived expiry. Null means it stands until withdrawn. */
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }),

    /** Which language the notice was actually read in — Section 5(3). */
    noticeLocale: text('notice_locale'),
    /** SHA-256 of what the device displayed, hashed on the device. */
    noticeTextSha256: text('notice_text_sha256'),
    /**
     * True when the device's hash did not match the published version.
     *
     * Recorded, never rejected. A stale render is indistinguishable from a
     * current one without this, and losing a real consent is worse than holding
     * an unverified one — but an unverified one has to be countable.
     */
    noticeMismatch: boolean('notice_mismatch').notNull().default(false),
    /**
     * How long the notice was on screen, and whether it was read aloud.
     *
     * The only objective signal of attestation quality that exists, given there
     * is no signature. A median of four seconds on a three-hundred-word notice
     * is a training problem, and nothing else would ever reveal it.
     */
    noticeSecondsShown: integer('notice_seconds_shown'),
    noticeReadAloud: boolean('notice_read_aloud'),

    /** Who attested, and what they were at the time. Roles change. */
    attestedBy: uuid('attested_by').references(() => users.id, { onDelete: 'set null' }),
    attestedRole: text('attested_role'),

    /** Whether this was a child, and how the worker knew. */
    subjectIsMinor: boolean('subject_is_minor'),
    minorBasis: minorBasisEnum('minor_basis'),

    /*
     * The guardian, denormalised.
     *
     * Not a `subjects` row: registering a guardian as a beneficiary pollutes
     * headcounts and duplicate detection. `guardian_evidence_seen` is the
     * *type* of document the worker saw — never its number, which would be
     * collecting an identifier to prove we were careful about identifiers.
     */
    guardianName: text('guardian_name'),
    guardianRelationship: text('guardian_relationship'),
    guardianContact: text('guardian_contact'),
    guardianEvidenceSeen: text('guardian_evidence_seen'),
    /**
     * False when a child's consent was recorded without a verified guardian.
     *
     * Stays false even after a supervisor approves the override. The whole
     * value of the design is that such a row remains visibly irregular — an
     * override that made the record look clean would be a permission.
     */
    guardianVerified: boolean('guardian_verified'),

    /** Set by the worker; cleared by a supervisor deciding. */
    pendingOverride: boolean('pending_override').notNull().default(false),
    overrideBy: uuid('override_by').references(() => users.id, { onDelete: 'set null' }),
    overrideRole: text('override_role'),
    /** Free text, in the worker's own language. A picklist yields "Other". */
    overrideReason: text('override_reason'),
    overrideAt: timestamp('override_at', { withTimezone: true, mode: 'date' }),

    /** Set when erasure has stripped the identifiers from this row. */
    redactedAt: timestamp('redacted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // Idempotency, mirroring `submissions_org_client_uuid_key`.
    uniqueIndex('consent_events_org_client_uuid_key').on(table.orgId, table.clientEventUuid),
    /*
     * The current-state index. Column order matters: the tenant is in the key
     * so a `WHERE org_id = $1` can be pushed down, and `seq` breaks ties.
     */
    index('consent_events_current_idx').on(
      table.orgId,
      table.subjectId,
      table.purposeId,
      table.occurredAt.desc(),
      table.seq.desc(),
    ),
    // Survives redaction, so the log stays countable after an erasure.
    index('consent_events_pseudonym_idx').on(table.orgId, table.subjectPseudonym),
    index('consent_events_pending_override_idx')
      .on(table.orgId, table.pendingOverride)
      .where(sql`pending_override`),
  ],
);

/**
 * Somebody asking to be forgotten, and what was done about it.
 *
 * Outlives the person. It is the artefact an auditor asks for and the clock a
 * grievance runs against, so deleting it along with the subject would destroy
 * the evidence that the request was honoured at all.
 */
export const erasureRequests = pgTable(
  'erasure_requests',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),

    /** Nulled when the purge runs; the pseudonym is what remains. */
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
    subjectPseudonym: text('subject_pseudonym').notNull(),
    /** Kept until completion so an admin can see who they are deciding about. */
    subjectNameAtRequest: text('subject_name_at_request'),

    status: erasureStatusEnum('status').notNull().default('requested'),
    mode: erasureModeEnum('mode').notNull().default('pseudonymise'),

    /**
     * Who asked, and how the organisation satisfied itself it was them.
     *
     * Free text because verification in this sector is a worker recognising
     * somebody they have visited for two years, not a document check — and a
     * dropdown would turn that into "Other".
     */
    requestedByName: text('requested_by_name'),
    requestedByRelationship: text('requested_by_relationship'),
    identityCheckedNote: text('identity_checked_note'),

    // Explicitly named: a request is received, not created and then updated,
    // and the query that orders by it has to be able to find the column.
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),

    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    /** Required on a refusal. "No" without a citable ground is not a refusal. */
    refusalStatute: text('refusal_statute'),
    refusalNote: text('refusal_note'),

    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** What the purge actually touched, for the record. */
    completedSummary: jsonb('completed_summary').$type<Record<string, number>>(),
  },
  (table) => [
    index('erasure_requests_org_status_idx').on(table.orgId, table.status),
    index('erasure_requests_subject_idx').on(table.subjectId),
  ],
);

/**
 * A statutory reason some data cannot be erased yet.
 *
 * Purpose-scoped, not organisation-wide. FCRA and Income Tax retention cover
 * financial and beneficiary-verification records — not a child's photograph. A
 * hold that swallowed everything would turn "we must keep some of this" into
 * "we keep all of it", which is the failure mode this shape exists to prevent.
 *
 * `expiresAt` is NOT NULL on purpose: an open-ended hold is a refusal wearing a
 * hat, and on expiry the record joins the purge queue by derivation with no job
 * to run.
 */
export const legalHolds = pgTable(
  'legal_holds',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    purposeId: uuid('purpose_id')
      .notNull()
      .references(() => purposes.id, { onDelete: 'cascade' }),
    statute: text('statute').notNull(),
    section: text('section'),
    note: text('note'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [index('legal_holds_org_purpose_idx').on(table.orgId, table.purposeId)],
);

/**
 * Counts kept before the rows behind them are destroyed.
 *
 * The thing that actually protects an organisation's impact numbers. A donor
 * report needs "1,240 children in Belagavi in Q2", not row-level data — and a
 * count genuinely is not personal data, so it needs no k-anonymity argument and
 * survives an erasure honestly.
 *
 * Written before a purge, never derived after one, because after the purge
 * there is nothing left to derive it from.
 */
export const programmeCounters = pgTable(
  'programme_counters',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    formId: uuid('form_id'),
    subjectTypeId: uuid('subject_type_id'),
    locationId: uuid('location_id'),
    /** First day of the month being counted. */
    period: timestamp('period', { withTimezone: true, mode: 'date' }).notNull(),
    recordCount: integer('record_count').notNull().default(0),
    peopleCount: integer('people_count').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('programme_counters_key').on(
      table.orgId,
      table.formId,
      table.subjectTypeId,
      table.locationId,
      table.period,
    ),
  ],
);
