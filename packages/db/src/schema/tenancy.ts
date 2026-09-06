import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums';
import { createdAt, i18nText, ltree, primaryId, updatedAt } from './_shared';

/** One NGO. The tenant boundary that every RLS policy keys on. */
export const organisations = pgTable(
  'organisations',
  {
    id: primaryId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    defaultLocale: text('default_locale').notNull().default('en'),
    /** Locales the org has switched on, e.g. `['en','hi','kn']`. */
    enabledLocales: jsonb('enabled_locales').$type<string[]>().notNull().default(['en']),
    /**
     * Names the levels of this org's location hierarchy, outermost first:
     * `[{key:'district',label:{en:'District'}}, {key:'village',...}]`.
     * An education NGO uses block → school → class; a health one uses
     * district → block → village. Neither should have to accept the other's.
     */
    locationLevels: jsonb('location_levels')
      .$type<{ key: string; label: Record<string, string> }[]>()
      .notNull()
      .default([]),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),

    /*
     * Who this organisation is, in law.
     *
     * Under the DPDP Act the NGO — not Sangraha — is the Data Fiduciary, and a
     * privacy notice that cannot name the body collecting the data or say how
     * to complain to it is non-compliant on its face. `name` above is the
     * working name a field worker sees in the header; these are for the notice,
     * the grievance route and the record of who accepted the processing terms.
     *
     * All nullable, so this is additive for the organisations that already
     * exist. The setup checklist asks for them, and publishing a consent notice
     * will require them — enforcement belongs where the admin can see and fix
     * it, not in a constraint that locks an existing tenant out of their own
     * data.
     */
    legalName: text('legal_name'),
    /** Society, trust, Section 8 company — free text; the list differs by state. */
    entityType: text('entity_type'),
    /** Registration, CIN, FCRA, 12A — whichever the organisation goes by. */
    registrationNumber: text('registration_number'),
    registeredAddress: text('registered_address'),

    /**
     * The person a Data Principal complains to (DPDP s8(9), s13).
     *
     * Required in the notice, so it is a real contact and not an inbox nobody
     * reads. Kept separate from the DPO: a Significant Data Fiduciary must
     * appoint a Data Protection Officer, but every Data Fiduciary needs a
     * grievance route, and most NGOs here will have the second without the
     * first.
     */
    grievanceOfficerName: text('grievance_officer_name'),
    grievanceOfficerEmail: text('grievance_officer_email'),
    grievanceOfficerPhone: text('grievance_officer_phone'),

    dpoName: text('dpo_name'),
    dpoEmail: text('dpo_email'),

    /**
     * Where this organisation's data is allowed to live.
     *
     * DPDP s16 is permissive by default, but the government-programme
     * agreements behind most s7(b) work are not, and routinely require the data
     * to stay in India. Recorded per organisation so the answer is a fact about
     * the tenant rather than a property of wherever the platform happens to be
     * deployed this quarter.
     */
    dataRegion: text('data_region').notNull().default('IN'),
    /** DPDP s10. Switches on the stricter obligations rather than forking the product. */
    isSignificantDataFiduciary: boolean('is_significant_data_fiduciary')
      .notNull()
      .default(false),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('organisations_slug_key').on(table.slug)],
);

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    /** Stored lowercased. Unique per organisation, not globally — two NGOs may
     *  both have a `sunita`. */
    username: text('username').notNull(),
    /** argon2id. Never a raw PIN, never reversible. */
    pinHash: text('pin_hash').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    role: userRoleEnum('role').notNull().default('field_worker'),
    /** Falls back to the organisation's default when null. */
    locale: text('locale'),
    isActive: boolean('is_active').notNull().default(true),
    /** A supervisor issues the first PIN; the worker is made to replace it. */
    mustChangePin: boolean('must_change_pin').notNull().default(true),
    /**
     * Bumped on PIN reset, role change or deactivation.
     *
     * Sessions are stateless JWTs, so this is what makes them revocable: a
     * token carrying an older version is rejected on its next request.
     */
    tokenVersion: integer('token_version').notNull().default(1),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_org_username_key').on(table.orgId, sql`lower(${table.username})`),
    index('users_org_role_idx').on(table.orgId, table.role),
  ],
);

/**
 * The location hierarchy. Depth and level names are per-organisation.
 */
export const locations = pgTable(
  'locations',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => locations.id, {
      onDelete: 'restrict',
    }),
    name: i18nText('name').notNull(),
    /** 0-based depth, indexing into `organisations.location_levels`. */
    level: smallint('level').notNull().default(0),
    /** Materialised path of ltree-safe ids, root first, including this node. */
    path: ltree('path').notNull(),
    /** The government or partner code for this place — UDISE, LGD, census. */
    externalCode: text('external_code'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // GiST is what makes ancestor/descendant containment (`<@`, `@>`) fast.
    index('locations_path_gist_idx').using('gist', table.path),
    index('locations_org_parent_idx').on(table.orgId, table.parentId),
    uniqueIndex('locations_org_external_code_key')
      .on(table.orgId, table.externalCode)
      .where(sql`external_code IS NOT NULL`),
  ],
);

/**
 * Which places a user may see.
 *
 * Assigning a node implies its whole subtree, so a block coordinator gets one
 * row rather than one per village.
 */
export const userLocations = pgTable(
  'user_locations',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.locationId] }),
    index('user_locations_location_idx').on(table.locationId),
  ],
);

/** Per-organisation API credentials for partner integrations. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First few characters, shown in the UI so a key can be identified without
     *  ever storing or re-displaying the secret. */
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('api_keys_hash_key').on(table.keyHash),
    index('api_keys_org_idx').on(table.orgId),
  ],
);
