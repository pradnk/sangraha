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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { FieldDataType, RuleNode } from '@sangraha/form-engine';
import { formAudienceEnum, formTypeEnum, formVersionStatusEnum } from './enums';
import { createdAt, i18nText, primaryId, updatedAt } from './_shared';
import { organisations, users } from './tenancy';
import { purposes } from './compliance';

/**
 * What kind of thing this organisation registers: Student, Household, Woman,
 * SHG Group, School. Entirely org-defined.
 */
export const subjectTypes = pgTable(
  'subject_types',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Stable slug used in API paths and analytics. Immutable once created. */
    code: text('code').notNull(),
    name: i18nText('name').notNull(),
    icon: text('icon'),
    /** Field keys composed into `subjects.display_name`, e.g. `['first_name','last_name']`.
     *  This is what a field worker sees in a search result, so the admin picks it. */
    displayNameFields: jsonb('display_name_fields').$type<string[]>().notNull().default([]),
    /**
     * Answers that must match exactly for two records to be flagged as the same
     * person — a phone number, a ration card number, a date of birth.
     *
     * Configured rather than guessed. A name similarity alone produces a lot of
     * false positives in a village where half the children share a surname, and
     * which second signal is trustworthy differs by programme.
     */
    matchFields: jsonb('match_fields').$type<string[]>().notNull().default([]),
    /**
     * Where this kind of subject's date of birth lives.
     *
     * Nominated rather than guessed, exactly like `matchFields` above, because
     * `attributes` is an arbitrary org-defined bag and nothing can know whether
     * `q7` is a birth date or a survey answer.
     *
     * The Act requires verifiable guardian consent for anyone under eighteen
     * and penalises getting it wrong more heavily than anything else in it. So
     * this is not a display convenience: it is how the system knows whether it
     * is talking to a child.
     */
    dateOfBirthField: text('date_of_birth_field'),
    /**
     * A recorded age in years, where no birth date was ever documented.
     *
     * Very common in rural registration — "age: 7" and nothing more. Without
     * this, every such child resolves to unknown, and a system that asks about
     * guardianship on every single record gets clicked through.
     */
    ageYearsField: text('age_years_field'),
    /**
     * A phone number or other way to reach this person.
     *
     * Needed for a duty nobody thinks about until it applies: a breach has to
     * be intimated to *each affected person*, and without a nominated contact
     * field that is not merely unimplemented, it is impossible.
     */
    contactField: text('contact_field'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('subject_types_org_code_key').on(table.orgId, table.code)],
);

export const forms = pgTable(
  'forms',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Immutable. Names the analytics view and the `/api/v1/data/{slug}` endpoint. */
    slug: text('slug').notNull(),
    name: i18nText('name').notNull(),
    description: i18nText('description'),
    formType: formTypeEnum('form_type').notNull().default('standalone'),
    /** Which registry entry this form registers or attaches to. */
    subjectTypeId: uuid('subject_type_id').references(() => subjectTypes.id, {
      onDelete: 'restrict',
    }),
    /** The version field workers currently get. Null until first publish. */
    currentVersionId: uuid('current_version_id'),
    /**
     * Who may open and fill this form in.
     *
     * Defaults to `everyone`, which is what every form did before this column
     * existed — narrowing is opt-in, so adding it took access away from nobody.
     * Org admins are outside the question entirely: they must be able to edit
     * and approve a form they are not themselves an audience of.
     *
     * Enforced in `app.can_use_form`, not here — see `sql/020-rls.sql`. The
     * capture API takes a `formVersionId` straight from the client, so a check
     * that lived only in the screens would not be a check.
     */
    audience: formAudienceEnum('audience').notNull().default('everyone'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('forms_org_slug_key').on(table.orgId, table.slug),
    index('forms_org_active_idx').on(table.orgId, table.isActive),
  ],
);

/**
 * Who may use a form, when its audience is `named`.
 *
 * Ignored for every other audience, and deliberately *not* cleared when the
 * audience changes: an admin who switches to "all field workers" to cover a
 * campaign and back again should find their list where they left it.
 *
 * Shaped like `user_locations`, which answers the same kind of question about
 * places: composite key, cascade from both sides, and an index on the user so
 * "which forms may this person use" is as cheap as the other direction.
 */
export const formAccess = pgTable(
  'form_access',
  {
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.formId, table.userId] }),
    index('form_access_user_idx').on(table.userId),
  ],
);

/**
 * An immutable snapshot of a form's structure.
 *
 * Publishing never mutates an existing version, so every submission can always
 * be interpreted against exactly the questions that were on screen when it was
 * captured. The admin never sees this — they just press Publish.
 */
export const formVersions = pgTable(
  'form_versions',
  {
    id: primaryId(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    status: formVersionStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('form_versions_form_number_key').on(table.formId, table.versionNumber),
    index('form_versions_form_status_idx').on(table.formId, table.status),
  ],
);

/** A reusable answer list — castes, grades, yes/no/unknown, service types. */
export const optionSets = pgTable(
  'option_sets',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: i18nText('name').notNull(),
    /** Shared sets appear in the builder for reuse across forms; defining
     *  "Castes" once and reusing it is what keeps codes consistent enough to
     *  aggregate across programs. */
    isShared: boolean('is_shared').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('option_sets_org_code_key').on(table.orgId, table.code)],
);

export const options = pgTable(
  'options',
  {
    id: primaryId(),
    optionSetId: uuid('option_set_id')
      .notNull()
      .references(() => optionSets.id, { onDelete: 'cascade' }),
    /** Immutable stable identity. This is the value stored in submissions and
     *  the value that appears in analytics. */
    code: text('code').notNull(),
    label: i18nText('label').notNull(),
    /** Locales whose label came from machine translation and is unreviewed. */
    labelMachine: jsonb('label_machine').$type<Record<string, boolean>>(),
    imageUrl: text('image_url'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Retired rather than deleted, so historical answers stay interpretable. */
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('options_set_code_key').on(table.optionSetId, table.code),
    index('options_set_sort_idx').on(table.optionSetId, table.sortOrder),
  ],
);

/**
 * One question, belonging to one immutable form version.
 *
 * `key` is the load-bearing column: it names the analytics column, the API
 * property and the CSV header, and it never changes. `label` is presentation
 * only and is free to be renamed or translated at will.
 */
export const formFields = pgTable(
  'form_fields',
  {
    id: primaryId(),
    formVersionId: uuid('form_version_id')
      .notNull()
      .references(() => formVersions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: i18nText('label').notNull(),
    help: i18nText('help'),
    /**
     * Locales whose label or hint came from machine translation and have not
     * been checked by a person.
     *
     * Kept beside the text rather than inside it so the label stays a plain
     * string everywhere it is rendered, and so an unreviewed draft is
     * identifiable without parsing it.
     */
    labelMachine: jsonb('label_machine').$type<Record<string, boolean>>(),
    helpMachine: jsonb('help_machine').$type<Record<string, boolean>>(),
    /** Matches `FieldDataType` in @sangraha/form-engine. Plain text rather than a
     *  Postgres enum so adding a field type needs no migration. */
    dataType: text('data_type').$type<FieldDataType>().notNull(),
    isRequired: boolean('is_required').notNull().default(false),
    /**
     * No two records on this form may hold the same answer here.
     *
     * Enforced when a submission is saved, not by a database constraint: a
     * unique index cannot be added to a form whose existing data already
     * repeats, and refusing to publish over old data would strand it. So the
     * rule binds new entries and leaves history alone.
     */
    isUnique: boolean('is_unique').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Set when this field sits inside a repeating group. */
    parentGroupId: uuid('parent_group_id').references((): AnyPgColumn => formFields.id, {
      onDelete: 'cascade',
    }),
    optionSetId: uuid('option_set_id').references(() => optionSets.id, { onDelete: 'restrict' }),
    /**
     * What this question is collected *for*.
     *
     * Nullable, and staying that way. A field is added before anybody has
     * decided its purpose, and making this NOT NULL would block publishing
     * every form that predates the decision. Enforcement belongs at publish,
     * where the admin can see which questions are unattributed and fix them.
     *
     * This is what lets the privacy notice be generated rather than written:
     * the system already knows every question it asks, so grouping them by
     * purpose produces the itemised notice the Act requires.
     */
    purposeId: uuid('purpose_id').references(() => purposes.id, { onDelete: 'set null' }),

    /**
     * The answer described as *data*, rather than as a question.
     *
     * A label is "Guardian's phone?" — fine on screen, comic in a notice that
     * reads "we collect: Guardian's phone?". Optional, falling back to the
     * label, so a notice can be generated without it and improved with it.
     */
    dataDescription: i18nText('data_description'),

    /** Type-specific settings, validated by that type's own `configSchema`. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Skip logic. A closed JSON AST — never an expression string. */
    visibilityRule: jsonb('visibility_rule').$type<RuleNode | null>(),
    /** Hidden from capture but kept so its historical answers stay readable.
     *  This is what the builder offers instead of deleting a field with data. */
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('form_fields_version_key_key').on(table.formVersionId, table.key),
    index('form_fields_version_sort_idx').on(table.formVersionId, table.sortOrder),
    index('form_fields_parent_idx').on(table.parentGroupId),
  ],
);

/**
 * Records which analytics views currently exist for a form, so the generator
 * can drop views for repeat groups that a later version removed.
 */
export const analyticsViews = pgTable(
  'analytics_views',
  {
    id: primaryId(),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    /** The organisation's analytics schema, e.g. `analytics_shiksha_demo`. */
    schemaName: text('schema_name').notNull(),
    viewName: text('view_name').notNull(),
    repeatGroupKey: text('repeat_group_key'),
    /** The exact SQL last executed — makes drift diagnosable. */
    definitionSql: text('definition_sql').notNull(),
    generatedAt: createdAt(),
  },
  (table) => [
    // Unique per schema, not globally: form slugs only have to be unique within
    // an organisation, so two NGOs may each own a `school_attendance` view.
    uniqueIndex('analytics_views_schema_name_key').on(table.schemaName, table.viewName),
    index('analytics_views_form_idx').on(table.formId),
  ],
);
