import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accessActionEnum, formVersionStatusEnum, lawfulBasisEnum } from './enums';
import { createdAt, i18nText, primaryId, updatedAt } from './_shared';
import { organisations, users } from './tenancy';

/**
 * Who looked at personal data, and what they took.
 *
 * Required, not nice to have. The DPDP Act obliges a Data Fiduciary to tell the
 * Board *and every affected person* what a breach exposed. Without a log,
 * neither question has an answer — "we cannot say who was affected" is not a
 * breach report. It is also the only thing that makes an exported CSV
 * traceable: once a file is on a laptop it cannot be recalled, so the most that
 * can ever be said is who took it and when.
 *
 * **Append-only, and not the largest table in the database.** Those pull in
 * opposite directions, so the rule is: one row per *act*, not per row of data.
 * Opening one person's profile is one row naming them. Exporting four hundred
 * records is one row with `rowCount = 400` — naming all four hundred would
 * quadruple the database to record a single click, and the form plus the filter
 * plus the count is enough to reconstruct the set.
 *
 * Note what this log is: personal data about staff. It needs its own retention
 * rule, and the actor columns are denormalised so that erasing a departed
 * worker can null the foreign key without destroying the record that somebody
 * acted.
 *
 * Deliberately no IP address. It would help attribute an intrusion, but it is
 * another piece of personal data on every row of a table that exists to protect
 * personal data, and it answers a different question — how a breach happened,
 * not who it affected. Revisit when there is a security team to read it.
 */
export const accessEvents = pgTable(
  'access_events',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),

    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Snapshots, so the log still reads after the account is gone or renamed. */
    actorUsername: text('actor_username'),
    actorRole: text('actor_role'),

    action: accessActionEnum('action').notNull(),
    /** `form`, `subject`, `submission`, `organisation` — what `targetId` names. */
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    /**
     * How many people's data this act touched.
     *
     * The difference between someone opening a record and someone downloading
     * the register. Null where it does not apply.
     */
    rowCount: integer('row_count'),
    /**
     * The filters in force, for an export or a list.
     *
     * Stored as the query string rather than parsed: it is what actually
     * decided the result set, and re-deriving it later from a changed filter
     * format would be guesswork.
     */
    scope: text('scope'),

    // Named `at`, not `created_at`: a log entry is not created and then
    // updated, it happens. Nothing here has an `updated_at` for the same reason.
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // The breach question: everything that touched this person.
    index('access_events_target_idx').on(table.orgId, table.targetType, table.targetId),
    // The oversight question: what has this person been doing.
    index('access_events_actor_idx').on(table.orgId, table.actorId, table.at),
    // The retention question: what is old enough to purge.
    index('access_events_at_idx').on(table.at),
  ],
);

export type AccessEventRow = typeof accessEvents.$inferSelect;

/**
 * Why an organisation collects something.
 *
 * The unit consent is given against. The Act requires consent to be *specific*,
 * so "do you agree to us holding your data" is not consent to anything — the
 * question has to be "do you agree to us using your child's attendance to run
 * the mid-day meal programme", and that is what a purpose names.
 *
 * `code` is immutable, for the same reason `form_fields.key` and `options.code`
 * are: it names an analytics column, a CSV header and an API property, and a
 * stored identifier derived from a label breaks the moment the label is
 * translated or reworded.
 */
export const purposes = pgTable(
  'purposes',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Immutable. `nutrition_survey`, `scholarship_delivery`. */
    code: text('code').notNull(),
    name: i18nText('name').notNull(),
    /**
     * What the organisation actually does with the data, in words a beneficiary
     * would use. This is the sentence read aloud, so it is the difference
     * between informed consent and a recital.
     */
    description: i18nText('description'),

    lawfulBasis: lawfulBasisEnum('lawful_basis').notNull().default('consent'),

    /**
     * How long the data may be kept after the purpose is served, in months.
     *
     * Null means "until the purpose is served" with no fixed clock — honest for
     * an open-ended programme, and deliberately not a synonym for forever: the
     * retention report lists these separately so they get reviewed rather than
     * quietly accumulating.
     */
    retentionMonths: integer('retention_months'),
    /**
     * A statute that requires the data to be kept regardless of a withdrawal.
     *
     * Purpose-scoped rather than organisation-wide, because FCRA and Income Tax
     * retention cover financial and beneficiary-verification records — not a
     * child's photograph. A refusal to erase has to name which data is held and
     * why, and erase everything else.
     */
    retentionStatute: text('retention_statute'),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('purposes_org_code_key').on(table.orgId, table.code)],
);

/**
 * A privacy notice, in the same shape as a form.
 *
 * `consent_notices` is the living thing an admin edits; `consent_notice_versions`
 * are immutable snapshots. Exactly the `forms` / `form_versions` pattern, and
 * for exactly the same reason: a consent event has to be interpretable years
 * later against the words that were actually on screen, and an editable notice
 * makes every past consent unprovable.
 */
export const consentNotices = pgTable(
  'consent_notices',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Immutable, names the notice in URLs and in the consent log. */
    slug: text('slug').notNull(),
    name: i18nText('name').notNull(),
    /** The version field workers currently read out. Null until first publish. */
    currentVersionId: uuid('current_version_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('consent_notices_org_slug_key').on(table.orgId, table.slug)],
);

export const consentNoticeVersions = pgTable(
  'consent_notice_versions',
  {
    id: primaryId(),
    noticeId: uuid('notice_id')
      .notNull()
      .references(() => consentNotices.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    status: formVersionStatusEnum('status').notNull().default('draft'),

    /**
     * The notice itself, per language.
     *
     * One blob rather than structured sections: it is read aloud start to
     * finish, and the thing that must be provable later is the exact words —
     * not a tree that could be re-rendered differently by a later version of
     * this code.
     */
    body: i18nText('body').notNull(),
    /** Which locales are unreviewed machine output, as elsewhere. */
    bodyMachine: jsonb('body_machine').$type<Record<string, boolean>>().notNull().default({}),

    /**
     * SHA-256 of the body per locale, computed at publish.
     *
     * A device renders the notice from props it fetched at some earlier point,
     * and there is no service worker to pin them — so a stale render is
     * otherwise indistinguishable from a current one. The phone hashes what it
     * actually displayed; a mismatch is recorded rather than rejected, because
     * losing real consent is worse than an unverified one.
     */
    bodySha256: jsonb('body_sha256').$type<Record<string, string>>().notNull().default({}),

    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Set when the organisation decides a published notice was inadequate.
     *
     * Consent taken under it stays valid history — it is what happened — but
     * the compliance report can then say "N people consented under a notice we
     * have since retracted", which is the only way to target re-consent.
     */
    retractedAt: timestamp('retracted_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('consent_notice_versions_number_key').on(table.noticeId, table.versionNumber),
    index('consent_notice_versions_status_idx').on(table.noticeId, table.status),
  ],
);

/** Which purposes a notice covers. A notice explains one or several. */
export const consentNoticePurposes = pgTable(
  'consent_notice_purposes',
  {
    noticeVersionId: uuid('notice_version_id')
      .notNull()
      .references(() => consentNoticeVersions.id, { onDelete: 'cascade' }),
    purposeId: uuid('purpose_id')
      .notNull()
      .references(() => purposes.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.noticeVersionId, table.purposeId] }),
    index('consent_notice_purposes_purpose_idx').on(table.purposeId),
  ],
);
