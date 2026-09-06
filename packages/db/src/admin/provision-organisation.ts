import { eq, sql } from 'drizzle-orm';
import { toSnakeCase, type I18nText } from '@sangraha/form-engine';
import type { Database, DbLike } from '../client';
import { organisations, users } from '../schema/tenancy';
import { assertPinAcceptable, hashPin } from '../auth/pin';

/**
 * Creates an organisation and its first administrator.
 *
 * Shared by the CLI and the self-serve signup screen so the two cannot drift —
 * slug derivation in particular, since the slug names the analytics schema and
 * is permanent.
 */

export interface ProvisionInput {
  name: string;
  /** Sign-in name for the first administrator. */
  adminUsername: string;
  /** Their display name. Defaults to the username. */
  adminFullName?: string;
  /**
   * The administrator's PIN.
   *
   * When they chose it themselves (signup) pass `mustChangePin: false`. When it
   * was issued for them (the CLI) leave it true so they are made to replace it.
   */
  adminPin: string;
  mustChangePin?: boolean;
  slug?: string;
  locales?: string[];
  locationLevels?: { key: string; label: I18nText }[];
}

export type ProvisionResult =
  | { ok: true; orgId: string; slug: string; userId: string }
  | { ok: false; reason: 'slug_taken' | 'invalid_slug' };

/** Derives a URL-safe, permanent slug from the organisation's name. */
export function deriveOrgSlug(name: string): string {
  return toSnakeCase(name).replaceAll('_', '-').slice(0, 50);
}

/**
 * Creates the organisation and its first administrator, or neither.
 *
 * Both halves happen in one transaction, and the PIN is checked *before* any
 * of it. That ordering is the whole point of this function's shape:
 *
 * The organisation used to be inserted first and the PIN hashed afterwards.
 * `hashPin` rejects a weak PIN by throwing, so somebody signing up with 111111
 * got an error message — and an organisation that had already been committed,
 * with no administrator and no way to sign into it. Their second attempt was
 * then refused for a name that "already exists", which was their own wreckage
 * from the first. Two bad outcomes from one missing transaction.
 *
 * The transaction alone would fix it; validating first as well means the
 * common mistake never opens a transaction that has to be rolled back, and
 * costs an Argon2 hash to discover.
 */
export async function provisionOrganisation(
  // The full Database, not DbLike: this needs its own transaction so a partly
  // created organisation cannot survive a failure half way through.
  db: Database,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const slug = input.slug?.trim() || deriveOrgSlug(input.name);
  if (!/^[a-z0-9-]+$/.test(slug)) return { ok: false, reason: 'invalid_slug' };

  // Throws WeakPinError, which the caller turns into a message. Nothing has
  // been written at this point, so there is nothing to undo.
  assertPinAcceptable(input.adminPin);

  /*
   * English is always enabled and always first.
   *
   * It is the one language the product is guaranteed to be fully translated
   * into, so it is the fallback when an organisation's own content has not been
   * translated yet. An organisation with no English at all would leave gaps
   * with nothing to fall back to.
   */
  const locales = ['en', ...(input.locales ?? []).filter((l) => l !== 'en')];
  const username = input.adminUsername.trim().toLowerCase();

  // Hashed outside the transaction: Argon2 is deliberately slow, and holding a
  // transaction open across it would pin a connection for no reason.
  const pinHash = await hashPin(input.adminPin);

  return db.transaction(async (tx): Promise<ProvisionResult> => {
    const [clash] = await tx
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.slug, slug))
      .limit(1);
    if (clash) return { ok: false, reason: 'slug_taken' };

    const [org] = await tx
      .insert(organisations)
      .values({
        name: input.name.trim(),
        slug,
        defaultLocale: 'en',
        enabledLocales: locales,
        locationLevels: input.locationLevels ?? [],
      })
      .returning({ id: organisations.id });

    const [user] = await tx
      .insert(users)
      .values({
        orgId: org!.id,
        username,
        pinHash,
        fullName: input.adminFullName?.trim() || username,
        role: 'org_admin',
        locale: 'en',
        mustChangePin: input.mustChangePin ?? true,
      })
      .returning({ id: users.id });

    return { ok: true, orgId: org!.id, slug, userId: user!.id };
  });
}

/**
 * How far through setting up an organisation is.
 *
 * Each step is derived from real data rather than a stored flag, so the guide
 * cannot claim something is done when it has been undone — and an organisation
 * set up before the guide existed shows the right state too.
 */
export interface SetupProgress {
  hasLogo: boolean;
  hasExtraLanguage: boolean;
  hasPlaces: boolean;
  hasForm: boolean;
  hasPublishedForm: boolean;
  hasTeam: boolean;
  hasSubmission: boolean;
  /**
   * A named person, reachable, who handles requests about personal data.
   *
   * A step rather than a hard block on publishing a form. The obligation is
   * real, but an organisation that cannot collect anything until it has settled
   * on a grievance officer will settle on one carelessly — and this checklist
   * is read, whereas a validation error is worked around.
   */
  hasPrivacyContact: boolean;
  /**
   * At least one reason for collecting anything has been written down.
   *
   * Without a purpose no question can be attributed to one, and without that
   * `consentRequirementFor` has nothing to ask about — so the capture screen
   * skips consent entirely and nobody is told. That silence is why this is a
   * step: an organisation registering children with no notice and no
   * attestation should not have to notice the absence for itself.
   */
  hasPurposes: boolean;
  /** A notice is written, published and covers at least one active purpose. */
  hasPublishedNotice: boolean;
  dismissed: boolean;
  /**
   * How much of each thing there is, not merely whether there is any.
   *
   * The booleans above answer "is this step done", which is all a checklist
   * needs and not enough for the screen it grew into. An organisation adding
   * its third programme is not setting up — it is administering — and "4
   * purposes" tells it where it stands where a green tick tells it nothing.
   */
  counts: SetupCounts;
}

export interface SetupCounts {
  places: number;
  languages: number;
  purposes: number;
  forms: number;
  publishedForms: number;
  notices: number;
  people: number;
  records: number;
  /** The name of whoever handles privacy requests, or null. */
  privacyContact: string | null;
}

export async function getSetupProgress(db: DbLike, orgId: string): Promise<SetupProgress> {
  const [row] = await db
    .select({
      enabledLocales: organisations.enabledLocales,
      settings: organisations.settings,
      grievanceName: organisations.grievanceOfficerName,
      grievanceEmail: organisations.grievanceOfficerEmail,
      grievancePhone: organisations.grievanceOfficerPhone,
      places: sql<number>`(SELECT count(*)::int FROM locations WHERE org_id = ${orgId})`,
      forms: sql<number>`(SELECT count(*)::int FROM forms WHERE org_id = ${orgId})`,
      published: sql<number>`(
        SELECT count(*)::int FROM form_versions fv
        JOIN forms f ON f.id = fv.form_id
        WHERE f.org_id = ${orgId} AND fv.status = 'published'
      )`,
      team: sql<number>`(SELECT count(*)::int FROM users WHERE org_id = ${orgId})`,
      logo: sql<number>`(SELECT count(*)::int FROM organisation_branding WHERE org_id = ${orgId})`,
      submissions: sql<number>`(SELECT count(*)::int FROM submissions WHERE org_id = ${orgId})`,
      purposes: sql<number>`(SELECT count(*)::int FROM purposes WHERE org_id = ${orgId} AND is_active)`,
      /*
       * A notice only counts when it is published *and* points at a purpose
       * that is still active. A draft nobody published, or one whose only
       * purpose has since been switched off, explains nothing to anybody — and
       * `consentRequirementFor` would pass over it for exactly that reason, so
       * counting it here would make the guide claim a step that changes
       * nothing.
       */
      notices: sql<number>`(
        SELECT count(*)::int
        FROM consent_notices n
        JOIN consent_notice_versions v ON v.id = n.current_version_id
        JOIN consent_notice_purposes np ON np.notice_version_id = v.id
        JOIN purposes p ON p.id = np.purpose_id AND p.is_active
        WHERE n.org_id = ${orgId} AND n.is_active
      )`,
    })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);

  const settings = (row?.settings ?? {}) as { setupDismissed?: boolean };

  return {
    hasLogo: Number(row?.logo ?? 0) > 0,
    hasExtraLanguage: (row?.enabledLocales ?? ['en']).length > 1,
    hasPlaces: Number(row?.places ?? 0) > 0,
    hasForm: Number(row?.forms ?? 0) > 0,
    hasPublishedForm: Number(row?.published ?? 0) > 0,
    // The founding administrator does not count as having a team.
    hasTeam: Number(row?.team ?? 0) > 1,
    hasSubmission: Number(row?.submissions ?? 0) > 0,
    // A name with no way to reach it is not a contact.
    hasPrivacyContact:
      filled(row?.grievanceName) && (filled(row?.grievanceEmail) || filled(row?.grievancePhone)),
    hasPurposes: Number(row?.purposes ?? 0) > 0,
    hasPublishedNotice: Number(row?.notices ?? 0) > 0,
    dismissed: settings.setupDismissed === true,
    counts: {
      places: Number(row?.places ?? 0),
      languages: (row?.enabledLocales ?? ['en']).length,
      purposes: Number(row?.purposes ?? 0),
      forms: Number(row?.forms ?? 0),
      publishedForms: Number(row?.published ?? 0),
      notices: Number(row?.notices ?? 0),
      people: Number(row?.team ?? 0),
      records: Number(row?.submissions ?? 0),
      privacyContact: filled(row?.grievanceName) ? (row?.grievanceName ?? null) : null,
    },
  };
}

const filled = (value: string | null | undefined): boolean => Boolean(value && value.trim() !== '');

export async function dismissSetupGuide(db: DbLike, orgId: string): Promise<void> {
  await db
    .update(organisations)
    .set({
      settings: sql`${organisations.settings} || '{"setupDismissed": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(organisations.id, orgId));
}
