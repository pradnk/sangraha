import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { SubmissionData } from '@sangraha/form-engine';
import { revisionChangeTypeEnum, subjectStatusEnum, submissionStatusEnum } from './enums';
import { createdAt, primaryId, updatedAt } from './_shared';
import { formVersions, forms, subjectTypes } from './config';
import { locations, organisations, users } from './tenancy';

/**
 * The registry: one row per person, household, group or institution.
 *
 * This is what separates the product from a pile of forms — a student
 * registered once accumulates attendance, assessments and follow-ups against
 * the same row, so "how did this child progress over the year?" is answerable.
 */
export const subjects = pgTable(
  'subjects',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    subjectTypeId: uuid('subject_type_id')
      .notNull()
      .references(() => subjectTypes.id, { onDelete: 'restrict' }),
    /** The NGO's own identifier — enrolment number, ration card, MIS code. */
    externalId: text('external_id'),
    /** Composed from the registration answers named in
     *  `subject_types.display_name_fields`. Denormalised deliberately: it is
     *  read on every search and every submission list. */
    displayName: text('display_name').notNull(),
    /** Registration answers, validated against the registration form version. */
    attributes: jsonb('attributes').$type<SubmissionData>().notNull().default({}),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    status: subjectStatusEnum('status').notNull().default('active'),
    registeredAt: timestamp('registered_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The record this one duplicates.
     *
     * A deliberate alternative to merging. A true merge has to decide which of
     * two conflicting values survives and then destroys the other, which is not
     * something to do to a beneficiary record on the strength of a fuzzy name
     * match. Both rows stay; this one points at the canonical one; search and
     * reporting follow the pointer. Reversible by setting it back to null.
     */
    duplicateOfId: uuid('duplicate_of_id').references((): AnyPgColumn => subjects.id, {
      onDelete: 'set null',
    }),
    duplicateMarkedBy: uuid('duplicate_marked_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    duplicateMarkedAt: timestamp('duplicate_marked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Soft delete. Beneficiary records are audited; nothing is truly removed. */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // Finds everything folded into a canonical record, for the profile screen
    // and for reporting to follow the pointer.
    index('subjects_duplicate_of_idx').on(table.duplicateOfId),
    uniqueIndex('subjects_org_type_external_key')
      .on(table.orgId, table.subjectTypeId, table.externalId)
      .where(sql`external_id IS NOT NULL AND deleted_at IS NULL`),
    // Trigram index for the field worker's "find a person" search, which has to
    // tolerate the spelling variation that comes with transliterated names.
    index('subjects_display_name_trgm_idx').using('gin', sql`${table.displayName} gin_trgm_ops`),
    index('subjects_org_type_idx').on(table.orgId, table.subjectTypeId),
    index('subjects_location_idx').on(table.locationId),
    index('subjects_attributes_gin_idx').using('gin', table.attributes),
  ],
);

/** Subject-to-subject links: child → household, member → SHG, student → school. */
export const subjectRelations = pgTable(
  'subject_relations',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    parentSubjectId: uuid('parent_subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    childSubjectId: uuid('child_subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    /** Org-defined: 'member_of', 'child_of', 'enrolled_in'. */
    relationType: text('relation_type').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('subject_relations_unique_key').on(
      table.parentSubjectId,
      table.childSubjectId,
      table.relationType,
    ),
    index('subject_relations_child_idx').on(table.childSubjectId),
  ],
);

/**
 * One filled-in form.
 *
 * Answers live in `data` as JSONB keyed by field key; the analytics views
 * flatten it back out into typed columns. Writes stay a single row, which is
 * what makes submission fast enough on a 2G connection.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'restrict' }),
    /** Pins the exact question set this was captured against. */
    formVersionId: uuid('form_version_id')
      .notNull()
      .references(() => formVersions.id, { onDelete: 'restrict' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
    data: jsonb('data').$type<SubmissionData>().notNull().default({}),
    status: submissionStatusEnum('status').notNull().default('submitted'),
    submittedBy: uuid('submitted_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    /**
     * Generated on the device before the first send attempt.
     *
     * The retry queue may deliver the same submission several times over a
     * flaky connection; this is what makes the write idempotent instead of
     * creating duplicate beneficiary visits.
     */
    clientUuid: uuid('client_uuid').notNull(),
    /** Browser, app version, connection type — for diagnosing field issues. */
    deviceMeta: jsonb('device_meta').$type<Record<string, unknown>>().notNull().default({}),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    reviewNote: text('review_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // Scoped to the org so two organisations cannot collide, and so a replayed
    // request from one tenant can never resolve to another's row.
    uniqueIndex('submissions_org_client_uuid_key').on(table.orgId, table.clientUuid),
    index('submissions_org_form_submitted_idx').on(table.orgId, table.formId, table.submittedAt),
    index('submissions_subject_submitted_idx').on(table.subjectId, table.submittedAt),
    index('submissions_submitted_by_idx').on(table.submittedBy, table.submittedAt),
    index('submissions_data_gin_idx').using('gin', table.data),
    // Drives the supervisor review queue.
    index('submissions_org_status_idx').on(table.orgId, table.status),
    // Drives `updated_since` incremental pulls for the warehouse sync.
    index('submissions_org_updated_idx').on(table.orgId, table.updatedAt),
  ],
);

/**
 * Append-only history of every change to a submission.
 *
 * Donor and statutory audits routinely ask who changed a number and when, so
 * corrections are recorded rather than overwritten.
 */
export const submissionRevisions = pgTable(
  'submission_revisions',
  {
    id: primaryId(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    revisionNo: integer('revision_no').notNull(),
    changeType: revisionChangeTypeEnum('change_type').notNull(),
    /** Full snapshot after the change. Storage is cheap; reconstructing a
     *  disputed value from deltas at audit time is not. */
    data: jsonb('data').$type<SubmissionData>().notNull(),
    status: submissionStatusEnum('status').notNull(),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    changedAt: createdAt(),
    reason: text('reason'),
  },
  (table) => [
    uniqueIndex('submission_revisions_no_key').on(table.submissionId, table.revisionNo),
    index('submission_revisions_submission_idx').on(table.submissionId, table.changedAt),
  ],
);

/** Photos, documents and signatures, stored in S3-compatible object storage. */
export const attachments = pgTable(
  'attachments',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Null while the file is uploaded but its submission not yet sent — the
     *  normal order of events on a phone. A sweeper reclaims orphans. */
    submissionId: uuid('submission_id').references(() => submissions.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'cascade' }),
    /** Which question this file answers. */
    fieldKey: text('field_key').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum'),
    originalFilename: text('original_filename'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('attachments_storage_key_key').on(table.storageKey),
    index('attachments_submission_idx').on(table.submissionId),
    index('attachments_org_created_idx').on(table.orgId, table.createdAt),
  ],
);
