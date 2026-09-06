import { and, asc, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { localise, type I18nText, type SubmissionData } from '@sangraha/form-engine';
import type { Database, DbLike } from '../client';
import { forms, subjectTypes } from '../schema/config';
import { locations, users } from '../schema/tenancy';
import { subjects, submissions } from '../schema/data';
import { composeDisplayName } from './subject-types';

/**
 * The registry.
 *
 * A form on its own records an event. A registry records a *person*, and hangs
 * every later event off them — which is the only way to answer "how did this
 * child progress over the year?" rather than "how many forms were filled in".
 */

export interface SubjectSummary {
  id: string;
  displayName: string;
  subjectTypeId: string;
  subjectTypeName: I18nText;
  externalId: string | null;
  locationId: string | null;
  locationName: I18nText | null;
  status: 'active' | 'inactive' | 'exited';
  registeredAt: Date;
  duplicateOfId: string | null;
  /**
   * The registration answers.
   *
   * Carried on the summary because a list of names is not enough to choose
   * from: two people really do share a name, and every screen that asks a
   * worker to pick one has to show what tells them apart. Safe here — unlike
   * the duplicate check, this query runs under Row-Level Security, so every
   * row returned is one the caller may already read in full.
   */
  attributes: SubmissionData;
  registeredByName: string | null;
}

const SUMMARY_COLUMNS = {
  id: subjects.id,
  displayName: subjects.displayName,
  subjectTypeId: subjects.subjectTypeId,
  subjectTypeName: subjectTypes.name,
  externalId: subjects.externalId,
  locationId: subjects.locationId,
  locationName: locations.name,
  status: subjects.status,
  registeredAt: subjects.registeredAt,
  duplicateOfId: subjects.duplicateOfId,
  attributes: subjects.attributes,
  registeredByName: users.fullName,
};

/**
 * Creates the person a registration form describes.
 *
 * Called inside the submission transaction, so a registration either produces
 * both a submission and a subject or neither — a half-registered person would
 * be invisible to search while still consuming an external id.
 */
export async function createSubjectFromRegistration(
  db: DbLike,
  input: {
    orgId: string;
    subjectTypeId: string;
    answers: SubmissionData;
    locationId: string | null;
    createdBy: string;
  },
): Promise<{ id: string; displayName: string }> {
  const [type] = await db
    .select({ name: subjectTypes.name, displayNameFields: subjectTypes.displayNameFields })
    .from(subjectTypes)
    .where(eq(subjectTypes.id, input.subjectTypeId))
    .limit(1);

  const displayName = composeDisplayName(
    type?.displayNameFields ?? [],
    input.answers,
    // Never nameless: an unnamed row in a "find a person" list is useless to
    // the person searching.
    localise(type?.name, 'en', 'Unnamed'),
  );

  const [created] = await db
    .insert(subjects)
    .values({
      orgId: input.orgId,
      subjectTypeId: input.subjectTypeId,
      displayName,
      attributes: input.answers,
      locationId: input.locationId,
      createdBy: input.createdBy,
    })
    .returning({ id: subjects.id });

  return { id: created!.id, displayName };
}

/**
 * Registers people for submissions that should have created one but did not.
 *
 * The situation this repairs: a registration form with no subject type saves
 * its submissions perfectly well and registers nobody, because there was no
 * type to register them as. Forms built before the registry existed are all in
 * that state, and the data is real — a field worker collected it — so the fix
 * has to be to catch the records up, not to ask anyone to type them again.
 *
 * Idempotent. Submissions that already point at a subject are skipped, so
 * running it twice cannot produce two records for one person.
 */
export async function backfillSubjectsForForm(
  db: DbLike,
  input: { orgId: string; formId: string; subjectTypeId: string; createdBy: string },
): Promise<{ registered: number }> {
  const [type] = await db
    .select({ name: subjectTypes.name, displayNameFields: subjectTypes.displayNameFields })
    .from(subjectTypes)
    .where(and(eq(subjectTypes.id, input.subjectTypeId), eq(subjectTypes.orgId, input.orgId)))
    .limit(1);

  if (!type) return { registered: 0 };

  const orphans = await db
    .select({
      id: submissions.id,
      data: submissions.data,
      locationId: submissions.locationId,
      submittedBy: submissions.submittedBy,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, input.orgId),
        eq(submissions.formId, input.formId),
        isNull(submissions.subjectId),
        isNull(submissions.deletedAt),
        // A draft is half-filled by definition; registering a person from one
        // would put a half-named record in everybody's search results.
        ne(submissions.status, 'draft'),
      ),
    )
    .orderBy(asc(submissions.submittedAt));

  const fallback = localise(type.name, 'en', 'Unnamed');

  for (const orphan of orphans) {
    const [created] = await db
      .insert(subjects)
      .values({
        orgId: input.orgId,
        subjectTypeId: input.subjectTypeId,
        displayName: composeDisplayName(type.displayNameFields, orphan.data, fallback),
        attributes: orphan.data,
        locationId: orphan.locationId,
        // Credited to whoever captured the record, not to the admin who
        // pressed the button — they are the person who actually met them.
        createdBy: orphan.submittedBy,
      })
      .returning({ id: subjects.id });

    await db
      .update(submissions)
      .set({ subjectId: created!.id })
      .where(eq(submissions.id, orphan.id));
  }

  return { registered: orphans.length };
}

/** How many of a form's submissions have nobody attached. */
export async function countUnregisteredSubmissions(
  db: DbLike,
  orgId: string,
  formId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, orgId),
        eq(submissions.formId, formId),
        isNull(submissions.subjectId),
        isNull(submissions.deletedAt),
        ne(submissions.status, 'draft'),
      ),
    );

  return row?.count ?? 0;
}

export interface SearchSubjectsOptions {
  query?: string;
  subjectTypeId?: string;
  limit?: number;
}

/**
 * Finds a person by name.
 *
 * Trigram similarity rather than a prefix match, because names reach the
 * database transliterated by whoever typed them — Sunita, Sunitha, Suneeta —
 * and a worker who has to spell it the same way twice will give up and
 * register a second copy.
 *
 * Ordinary Row-Level Security applies: this is browsing, and a worker has no
 * business paging through another block's beneficiaries.
 */
export async function searchSubjects(
  db: DbLike,
  options: SearchSubjectsOptions = {},
): Promise<SubjectSummary[]> {
  const query = options.query?.trim();
  const filters: SQL[] = [
    isNull(subjects.deletedAt),
    // A record folded into another is not a separate person.
    isNull(subjects.duplicateOfId),
  ];
  if (options.subjectTypeId) filters.push(eq(subjects.subjectTypeId, options.subjectTypeId));

  if (query) {
    filters.push(
      or(
        sql`${subjects.displayName} % ${query}`,
        sql`${subjects.displayName} ILIKE ${`%${query}%`}`,
        eq(subjects.externalId, query),
      )!,
    );
  }

  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(subjects)
    .innerJoin(subjectTypes, eq(subjectTypes.id, subjects.subjectTypeId))
    .leftJoin(locations, eq(locations.id, subjects.locationId))
    .leftJoin(users, eq(users.id, subjects.createdBy))
    .where(and(...filters))
    .orderBy(
      // Best match first when searching; most recent first when browsing.
      query
        ? desc(sql`similarity(${subjects.displayName}, ${query})`)
        : desc(subjects.registeredAt),
    )
    .limit(options.limit ?? 25);

  return rows as SubjectSummary[];
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * How alike two names must be before a worker is asked about them.
 *
 * Measured against the real thing: `similarity('Sunita Devi', 'Sunitha Devi')`
 * is 0.67 and unrelated names score 0. Below about 0.4 the question starts
 * firing on strangers, and a warning that is usually wrong is a warning workers
 * learn to dismiss without reading.
 */
export const NAME_SIMILARITY_THRESHOLD = 0.4;

export interface DuplicateMatch {
  id: string;
  displayName: string;
  externalId: string | null;
  locationName: I18nText | null;
  registeredAt: Date;
  registeredByName: string | null;
  score: number;
  /** `name`, `external_id`, or the key of a matching answer. */
  reasons: string[];
  /**
   * The registration answers, so two people with the same name can actually be
   * told apart.
   *
   * Without these the screen showed two identical cards and asked the worker to
   * choose, which is not a question anybody can answer. Only ever populated for
   * matches the caller is allowed to see — the database itself withholds them
   * for the rest, rather than this code remembering to.
   */
  attributes: SubmissionData;
}

export interface DuplicateCheckResult {
  /** Full detail — these are people the caller is already allowed to see. */
  visible: DuplicateMatch[];
  /**
   * How many similar records exist outside the caller's locations.
   *
   * A count and nothing else. Knowing that *someone* similar is registered
   * elsewhere is enough to send the worker to their supervisor; knowing who,
   * and where, would hand a village worker a lookup tool for the whole
   * organisation's beneficiaries.
   */
  hiddenCount: number;
}

export interface FindDuplicatesInput {
  orgId: string;
  subjectTypeId: string;
  /** The name as it would be composed from the answers just entered. */
  displayName: string;
  answers: SubmissionData;
  externalId?: string | null;
  /** Answer keys that must match exactly, from `subject_types.match_fields`. */
  matchFields: string[];
  /** Whose visibility to apply when splitting the results. */
  viewer: { userId: string; role: string };
  /** Excluded from the results — used when re-checking an existing record. */
  excludeId?: string;
  limit?: number;
}

/**
 * Looks for someone already registered who might be this same person.
 *
 * **Runs on the owner connection, which bypasses Row-Level Security.** That is
 * deliberate and it is the only reason this function exists separately from
 * `searchSubjects`: a duplicate registered in the next district is exactly the
 * one RLS hides, and it is exactly the one worth warning about. Every caller
 * must pass the owner database.
 *
 * Because RLS is off, the org scope below is not a convenience — it is the
 * tenant boundary, and it is enforced here or nowhere. The location boundary is
 * then re-applied per row via `app.can_see_location`, the same function the
 * policies use, so there is one definition of "may this person see that place"
 * rather than a second one drifting in TypeScript.
 */
export async function findDuplicateCandidates(
  // Typed as the full Database, not DbLike, because it needs its own
  // transaction to scope the session settings — and because the type is a
  // reminder that this is the owner connection.
  db: Database,
  input: FindDuplicatesInput,
): Promise<DuplicateCheckResult> {
  const name = input.displayName.trim();
  const externalId = input.externalId?.trim() || null;

  // Answers the type says identify a person — a phone number, a ration card.
  const exactPairs = input.matchFields
    .map((key) => [key, input.answers[key]] as const)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([key, value]) => [key, String(value).trim()] as const);

  // Nothing to go on. Better to ask nothing than to compare empty strings,
  // which match everything.
  if (name.length < 3 && !externalId && exactPairs.length === 0) {
    return { visible: [], hiddenCount: 0 };
  }

  const signals: SQL[] = [];
  const reasonCases: SQL[] = [];

  if (name.length >= 3) {
    // The `%` operator, not `similarity(...) >= x`, so the GIN trigram index is
    // usable. Its cutoff is the session threshold set below.
    signals.push(sql`s.display_name % ${name}`);
    reasonCases.push(sql`CASE WHEN s.display_name % ${name} THEN 'name' END`);
  }
  if (externalId) {
    signals.push(sql`s.external_id = ${externalId}`);
    reasonCases.push(sql`CASE WHEN s.external_id = ${externalId} THEN 'external_id' END`);
  }
  for (const [key, value] of exactPairs) {
    signals.push(sql`s.attributes->>${key} = ${value}`);
    reasonCases.push(sql`CASE WHEN s.attributes->>${key} = ${value} THEN ${key} END`);
  }

  const rows = await db.transaction(async (tx) => {
    /*
     * Set inside the transaction, so nothing leaks to the next request served
     * by this pooled connection. `app.can_see_location` reads the user and
     * role from exactly these settings.
     */
    await tx.execute(
      sql`select set_config('pg_trgm.similarity_threshold', ${String(NAME_SIMILARITY_THRESHOLD)}, true)`,
    );
    await tx.execute(sql`select set_config('app.user_id', ${input.viewer.userId}, true)`);
    await tx.execute(sql`select set_config('app.role', ${input.viewer.role}, true)`);
    await tx.execute(sql`select set_config('app.org_id', ${input.orgId}, true)`);

    /*
     * Two things the LIMIT must not be allowed to do, and it used to do both.
     *
     * It was applied before the visible/hidden split, which happened afterwards
     * in TypeScript — so in an organisation with a "Lakshmi Devi" in thirty
     * villages, ten near-identical scores from elsewhere filled the ten slots,
     * the worker's own village's Lakshmi Devi ranked eleventh, and the answer
     * came back as `visible: []` with `hiddenCount: 10`. The worker was told
     * somebody similar existed somewhere else, tapped "Register anyway", and
     * created exactly the local duplicate the check exists to prevent.
     *
     * And it capped the hidden count at ten as well, so "10" could mean ten or
     * four hundred.
     *
     * `matches` therefore holds every candidate; the limit is taken over the
     * visible ones alone, and the hidden ones are counted in full. `totals` has
     * exactly one row, so the LEFT JOIN LATERAL still yields the count when
     * nothing visible matched at all.
     */
    return (await tx.execute(sql`
      WITH matches AS (
        SELECT
          s.id,
          s.display_name,
          s.external_id,
          -- Emitted as strict ISO 8601. Postgres's own text form, which ends
          -- in a bare +00, is rejected by Safari on iOS — and these rows are
          -- read on phones.
          to_char(s.registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at,
          loc.name AS location_name,
          u.full_name AS registered_by_name,
          similarity(s.display_name, ${name}) AS score,
          app.can_see_location(s.location_id) AS visible,
          -- Withheld in SQL, not filtered in TypeScript. A row this caller may
          -- not see must not have its answers travel any further than the query
          -- that counted it.
          CASE WHEN app.can_see_location(s.location_id) THEN s.attributes END AS attributes,
          array_remove(ARRAY[${sql.join(reasonCases, sql`, `)}], NULL) AS reasons
        FROM subjects s
        LEFT JOIN locations loc ON loc.id = s.location_id
        LEFT JOIN users u ON u.id = s.created_by
        WHERE s.org_id = ${input.orgId}
          AND s.subject_type_id = ${input.subjectTypeId}
          AND s.deleted_at IS NULL
          -- Already folded into another record; warning about it would send the
          -- worker to a record that is not the one being used.
          AND s.duplicate_of_id IS NULL
          ${input.excludeId ? sql`AND s.id <> ${input.excludeId}` : sql``}
          AND (${sql.join(signals, sql` OR `)})
      ),
      totals AS (SELECT count(*) FILTER (WHERE NOT visible)::int AS hidden_total FROM matches)
      SELECT m.*, t.hidden_total
      FROM totals t
      LEFT JOIN LATERAL (
        SELECT * FROM matches
        WHERE visible
        ORDER BY score DESC, registered_at DESC
        LIMIT ${input.limit ?? 10}
      ) m ON true
    `)) as unknown as {
      id: string;
      display_name: string;
      external_id: string | null;
      registered_at: string;
      location_name: I18nText | null;
      registered_by_name: string | null;
      score: number;
      visible: boolean;
      reasons: string[];
      attributes: SubmissionData | null;
      hidden_total: number;
    }[];
  });

  const visible: DuplicateMatch[] = [];
  // One row always comes back, carrying the count even when nothing visible
  // matched — in which case its other columns are null.
  const hiddenCount = Number(rows[0]?.hidden_total ?? 0);

  for (const row of rows) {
    /*
     * Counted in SQL, never described here. The privacy promise is kept by the
     * hidden rows never leaving the database at all, rather than by filtering
     * them out of a result that already travelled.
     */
    if (!row.id) continue;
    visible.push({
      id: row.id,
      displayName: row.display_name,
      externalId: row.external_id,
      locationName: row.location_name,
      registeredAt: new Date(row.registered_at),
      registeredByName: row.registered_by_name,
      score: Number(row.score),
      reasons: row.reasons,
      attributes: row.attributes ?? {},
    });
  }

  return { visible, hiddenCount };
}

export interface SubjectDetail extends SubjectSummary {
  attributes: SubmissionData;
  createdByName: string | null;
  duplicateOfName: string | null;
  /** Records folded into this one. */
  duplicates: { id: string; displayName: string }[];
}

export async function getSubject(db: DbLike, id: string): Promise<SubjectDetail | null> {
  const canonical = sql<
    string | null
  >`(SELECT s2.display_name FROM subjects s2 WHERE s2.id = ${subjects.duplicateOfId})`;

  const [row] = await db
    .select({
      ...SUMMARY_COLUMNS,
      createdByName: users.fullName,
      duplicateOfName: canonical.as('duplicate_of_name'),
    })
    .from(subjects)
    .innerJoin(subjectTypes, eq(subjectTypes.id, subjects.subjectTypeId))
    .leftJoin(locations, eq(locations.id, subjects.locationId))
    .leftJoin(users, eq(users.id, subjects.createdBy))
    .where(and(eq(subjects.id, id), isNull(subjects.deletedAt)))
    .limit(1);

  if (!row) return null;

  const folded = await db
    .select({ id: subjects.id, displayName: subjects.displayName })
    .from(subjects)
    .where(and(eq(subjects.duplicateOfId, id), isNull(subjects.deletedAt)));

  return { ...(row as SubjectDetail), duplicates: folded };
}

export interface TimelineEntry {
  submissionId: string;
  formId: string;
  formSlug: string;
  formName: I18nText;
  formVersionId: string;
  formType: 'registration' | 'encounter' | 'standalone';
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  submittedAt: Date;
  submittedByName: string | null;
  data: SubmissionData;
}

/**
 * Everything recorded about a person, newest first.
 *
 * The payoff of the registry, and the reason `submissions.subject_id` exists.
 * Spans form versions deliberately — a visit recorded last year against an
 * older version of the form is still part of this person's history, and each
 * entry carries the version it was captured under so it renders as it was
 * asked.
 */
export async function getSubjectTimeline(
  db: DbLike,
  subjectId: string,
): Promise<TimelineEntry[]> {
  const rows = await db
    .select({
      submissionId: submissions.id,
      formId: submissions.formId,
      formSlug: forms.slug,
      formName: forms.name,
      formVersionId: submissions.formVersionId,
      formType: forms.formType,
      status: submissions.status,
      submittedAt: submissions.submittedAt,
      submittedByName: users.fullName,
      data: submissions.data,
    })
    .from(submissions)
    .innerJoin(forms, eq(forms.id, submissions.formId))
    .leftJoin(users, eq(users.id, submissions.submittedBy))
    .where(and(eq(submissions.subjectId, subjectId), isNull(submissions.deletedAt)))
    .orderBy(desc(submissions.submittedAt));

  return rows as TimelineEntry[];
}

/** Encounter forms that can be recorded against a given kind of subject. */
export async function listEncounterForms(
  db: DbLike,
  orgId: string,
  subjectTypeId: string,
): Promise<{ id: string; slug: string; name: I18nText }[]> {
  return db
    .select({ id: forms.id, slug: forms.slug, name: forms.name })
    .from(forms)
    .where(
      and(
        eq(forms.orgId, orgId),
        eq(forms.subjectTypeId, subjectTypeId),
        eq(forms.formType, 'encounter'),
        eq(forms.isActive, true),
      ),
    )
    .orderBy(asc(forms.slug));
}

/**
 * Marks one record as the same person as another.
 *
 * Deliberately not a merge. A merge has to choose which of two conflicting
 * values survives and then destroys the other, which is not a thing to do to a
 * beneficiary record on the strength of a fuzzy name match. Both rows stay and
 * this one points at the canonical record; setting it back to null undoes it
 * completely.
 */
export type LinkDuplicateResult = { ok: true } | { ok: false; reason: string };

export async function markAsDuplicate(
  db: DbLike,
  input: { subjectId: string; canonicalId: string; markedBy: string },
): Promise<LinkDuplicateResult> {
  if (input.subjectId === input.canonicalId) {
    return { ok: false, reason: 'A record cannot be a duplicate of itself.' };
  }

  const [canonical] = await db
    .select({ duplicateOfId: subjects.duplicateOfId })
    .from(subjects)
    .where(and(eq(subjects.id, input.canonicalId), isNull(subjects.deletedAt)))
    .limit(1);

  if (!canonical) return { ok: false, reason: 'That record could not be found.' };

  // Chains would make "which record is the real one?" ambiguous, and reporting
  // would have to walk an arbitrary depth to find out.
  if (canonical.duplicateOfId) {
    return {
      ok: false,
      reason: 'That record is itself marked as a duplicate. Point at the original instead.',
    };
  }

  /*
   * The other end of the same rule, and the half that was missing.
   *
   * The clause below checks the *source* is not already a duplicate. Nothing
   * checked whether anything was folded into it — so marking C a duplicate of
   * B and then B a duplicate of A both passed, giving C → B → A. `searchSubjects`
   * hides B and C, `getSubject(A)` lists only B, and C is orphaned behind a
   * record that is no longer canonical itself. The existing test only ever
   * tried the order that happened to be refused.
   */
  const [dependant] = await db
    .select({ id: subjects.id })
    .from(subjects)
    .where(and(eq(subjects.duplicateOfId, input.subjectId), isNull(subjects.deletedAt)))
    .limit(1);

  if (dependant) {
    return {
      ok: false,
      reason:
        'Other records are already marked as duplicates of this one. Point those at the original first.',
    };
  }

  const [updated] = await db
    .update(subjects)
    .set({
      duplicateOfId: input.canonicalId,
      duplicateMarkedBy: input.markedBy,
      duplicateMarkedAt: new Date(),
      updatedAt: new Date(),
    })
    // A record already folded into something else cannot be folded again.
    .where(
      and(
        eq(subjects.id, input.subjectId),
        isNull(subjects.duplicateOfId),
        ne(subjects.id, input.canonicalId),
      ),
    )
    .returning({ id: subjects.id });

  if (!updated) {
    return { ok: false, reason: 'That record is already marked as a duplicate.' };
  }

  return { ok: true };
}

export async function unmarkDuplicate(db: DbLike, subjectId: string): Promise<void> {
  await db
    .update(subjects)
    .set({
      duplicateOfId: null,
      duplicateMarkedBy: null,
      duplicateMarkedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(subjects.id, subjectId));
}
