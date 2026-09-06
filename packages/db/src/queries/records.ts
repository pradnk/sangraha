import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  analyticsSchemaName,
  mainViewName,
  pgIdentifier,
  type I18nText,
} from '@sangraha/form-engine';
import type { Database, DbLike } from '../client';
import { analyticsViews, forms } from '../schema/config';
import { organisations } from '../schema/tenancy';

/**
 * Reading an organisation's own data back out.
 *
 * Everything here goes through the generated analytics views rather than
 * re-deriving anything from the JSONB. The view is already flattened, already
 * typed, and already spans every published version of the form — reimplementing
 * that here would mean two answers to the same question, and one of them
 * eventually being wrong.
 *
 * **Those views run with owner rights, so Row-Level Security does not constrain
 * them.** Reading one therefore returns the whole organisation, which is why
 * every entry point below is restricted to `org_admin`. A supervisor keeps the
 * review queue. Revisiting this with `security_invoker` views would let
 * supervisors have a location-scoped version; noted rather than quietly
 * accepted.
 */

export interface RecordView {
  formId: string;
  formSlug: string;
  formName: I18nText;
  formType: 'registration' | 'encounter' | 'standalone';
  schemaName: string;
  viewName: string;
}

/** Forms this organisation has data views for, for the Records index. */
export async function listRecordViews(db: DbLike, orgId: string): Promise<RecordView[]> {
  const rows = await db
    .select({
      formId: forms.id,
      formSlug: forms.slug,
      formName: forms.name,
      formType: forms.formType,
      schemaName: analyticsViews.schemaName,
      viewName: analyticsViews.viewName,
    })
    .from(analyticsViews)
    .innerJoin(forms, eq(forms.id, analyticsViews.formId))
    .where(
      and(
        eq(forms.orgId, orgId),
        // Only the form's own view. Repeat-group children and the subject
        // dimension are reachable from it, not listed beside it as if they
        // were separate forms.
        sql`${analyticsViews.repeatGroupKey} IS NULL`,
      ),
    )
    .orderBy(asc(forms.slug));

  /*
   * The main view is matched by name, and the name is not always the slug:
   * `mainViewName` truncates past 63 characters and appends `_form` when the
   * slug collides with a reserved view name. Comparing against `forms.slug` in
   * SQL — which is what this did — silently dropped either case from Records
   * with nothing to explain the absence. Filtering here rather than in the
   * predicate keeps the rule in its one definition; the row count is a couple
   * per form, so there is nothing to gain by pushing it down.
   */
  return (rows as RecordView[]).filter((row) => row.viewName === mainViewName(row.formSlug));
}

export interface FormRecordCount {
  formId: string;
  total: number;
  awaitingReview: number;
  /** When the most recent record arrived, or null if there are none. */
  lastRecordAt: Date | null;
}

/**
 * How much data each form holds, for the Records index.
 *
 * One aggregate over `submissions` rather than a query per form: an index that
 * costs N round trips to render is an index that stops being rendered.
 *
 * Read through `submissions` and not through the generated views, which are
 * one relation per form and could not be aggregated in a single statement.
 * That means RLS applies — the index runs on the request connection, so this is
 * one of the few Records queries whose tenant boundary is the policy rather
 * than an `org_admin` route guard. The `orgId` filter is still passed, because
 * a caller on the owner connection would otherwise count everybody.
 *
 * Drafts are excluded, matching the views: a half-filled form on somebody's
 * phone is not a record, and counting it here would make the index disagree
 * with the number on the form's own screen.
 */
export async function countRecordsPerForm(
  db: DbLike,
  orgId: string,
): Promise<Map<string, FormRecordCount>> {
  const rows = (await db.execute(sql`
    SELECT
      form_id,
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'submitted')::int AS awaiting_review,
      max(submitted_at) AS last_record_at
    FROM public.submissions
    WHERE org_id = ${orgId} AND status <> 'draft'
    GROUP BY form_id
  `)) as unknown as {
    form_id: string;
    total: number;
    awaiting_review: number;
    last_record_at: Date | string | null;
  }[];

  return new Map(
    rows.map((row) => [
      row.form_id,
      {
        formId: row.form_id,
        total: row.total,
        awaitingReview: row.awaiting_review,
        lastRecordAt: row.last_record_at ? new Date(row.last_record_at) : null,
      },
    ]),
  );
}

/**
 * How many people the organisation has registered.
 *
 * Duplicates that have been merged away are excluded — they are still rows, so
 * counting them would tell an admin they have more beneficiaries than they do,
 * which is the one direction this number must not err in.
 */
export async function countRegisteredPeople(db: DbLike, orgId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS total
    FROM public.subjects
    WHERE org_id = ${orgId} AND duplicate_of_id IS NULL
  `)) as unknown as { total: number }[];

  return row?.total ?? 0;
}

/**
 * Resolves one form's view, confirming it belongs to the caller's organisation.
 *
 * The org check is the security boundary for everything that follows: past this
 * point the queries read an owner-rights view, and the only thing keeping one
 * NGO out of another's data is that this returned null.
 */
export async function getRecordView(
  db: DbLike,
  orgId: string,
  slug: string,
): Promise<RecordView | null> {
  const [row] = await db
    .select({
      formId: forms.id,
      formSlug: forms.slug,
      formName: forms.name,
      formType: forms.formType,
      schemaName: analyticsViews.schemaName,
      viewName: analyticsViews.viewName,
      orgSlug: organisations.slug,
    })
    .from(forms)
    .innerJoin(organisations, eq(organisations.id, forms.orgId))
    .innerJoin(
      analyticsViews,
      and(
        eq(analyticsViews.formId, forms.id),
        sql`${analyticsViews.repeatGroupKey} IS NULL`,
        // The slug is known here, so the one definition of the view's name can
        // be evaluated in JS and bound — see `listRecordViews`.
        eq(analyticsViews.viewName, mainViewName(slug)),
      ),
    )
    .where(and(eq(forms.orgId, orgId), eq(forms.slug, slug)))
    .limit(1);

  if (!row) return null;

  /*
   * Belt and braces. `schemaName` is written by the view generator, but this is
   * the one place a stored string is turned into SQL, so it is checked against
   * what the organisation's schema name must be rather than trusted.
   */
  if (row.schemaName !== analyticsSchemaName(row.orgSlug)) return null;

  return {
    formId: row.formId,
    formSlug: row.formSlug,
    formName: row.formName,
    formType: row.formType,
    schemaName: row.schemaName,
    viewName: row.viewName,
  };
}

export interface RecordColumn {
  name: string;
  pgType: string;
}

/** The view's columns, in the order the generator emitted them. */
export async function listRecordColumns(
  db: DbLike,
  view: RecordView,
): Promise<RecordColumn[]> {
  /*
   * `udt_name` for the array case, because `data_type` does not distinguish
   * them: it reports the string `ARRAY` for `text[]`, `integer[]` and every
   * other array alike. `kindForPgType` was looking for a `[]` suffix that
   * `data_type` never produces, so multi-choice answers were rendered as raw
   * JSON option codes — and the test went on passing because it fed in the
   * *generator's* `text[]` rather than what the database reports.
   *
   * `udt_name` gives `_text` for `text[]`, so it is normalised back into the
   * form the rest of the code already understands.
   */
  const rows = (await db.execute(sql`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = ${view.schemaName} AND table_name = ${view.viewName}
    ORDER BY ordinal_position
  `)) as unknown as { column_name: string; data_type: string; udt_name: string }[];

  return rows.map((row) => ({
    name: row.column_name,
    pgType:
      row.data_type === 'ARRAY' ? `${row.udt_name.replace(/^_/, '')}[]` : row.data_type,
  }));
}

export interface RecordFilters {
  /** Inclusive, as a date the admin typed — not a timestamp. */
  from?: string | null;
  to?: string | null;
  status?: string | null;
  /** A location and everything beneath it, by ltree containment. */
  locationId?: string | null;
}

export const RECORD_STATUSES = ['submitted', 'approved', 'rejected'] as const;

/** Builds the shared WHERE clause, so the table and the CSV cannot diverge. */
function buildFilters(filters: RecordFilters): SQL {
  const clauses: SQL[] = [sql`TRUE`];

  if (filters.from) clauses.push(sql`v.submitted_at >= ${filters.from}::date`);
  // Exclusive upper bound on the *next* day, so "to 5 August" includes
  // everything captured on the 5th rather than only the midnight instant.
  if (filters.to) clauses.push(sql`v.submitted_at < (${filters.to}::date + 1)`);

  if (filters.status && (RECORD_STATUSES as readonly string[]).includes(filters.status)) {
    clauses.push(sql`v.status = ${filters.status}`);
  }

  if (filters.locationId) {
    // Subtree containment: filtering to a district includes every village in
    // it, which is what an admin means by "this district".
    clauses.push(sql`EXISTS (
      SELECT 1 FROM public.locations sel
      JOIN public.locations here ON here.id = v.location_id
      WHERE sel.id = ${filters.locationId} AND here.path <@ sel.path
    )`);
  }

  return sql.join(clauses, sql` AND `);
}

export interface RecordCounts {
  total: number;
  approved: number;
  awaitingReview: number;
  rejected: number;
}

export async function countRecords(
  db: Database,
  view: RecordView,
  filters: RecordFilters,
): Promise<RecordCounts> {
  const from = sql.raw(`${pgIdentifier(view.schemaName)}.${pgIdentifier(view.viewName)}`);

  const [row] = (await db.execute(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE v.status = 'approved')::int AS approved,
      count(*) FILTER (WHERE v.status = 'submitted')::int AS awaiting_review,
      count(*) FILTER (WHERE v.status = 'rejected')::int AS rejected
    FROM ${from} v
    WHERE ${buildFilters(filters)}
  `)) as unknown as {
    total: number;
    approved: number;
    awaiting_review: number;
    rejected: number;
  }[];

  return {
    total: row?.total ?? 0,
    approved: row?.approved ?? 0,
    awaitingReview: row?.awaiting_review ?? 0,
    rejected: row?.rejected ?? 0,
  };
}

/**
 * How many records a page may show.
 *
 * Offered rather than fixed because "how much is in here?" and "find me this
 * one row" want different answers. 500 is only a sensible ceiling because the
 * table no longer renders thirteen columns of ids by default — the two changes
 * pay for each other.
 */
export const RECORD_PAGE_SIZES = [50, 100, 250, 500] as const;
export const RECORDS_PAGE_SIZE = RECORD_PAGE_SIZES[0];

/** Clamped here as well as at the URL, so a caller cannot ask for the lot. */
export function clampPageSize(value: unknown): number {
  const asNumber = Number(value);
  return (RECORD_PAGE_SIZES as readonly number[]).includes(asNumber)
    ? asNumber
    : RECORDS_PAGE_SIZE;
}

export interface RecordPage {
  rows: Record<string, unknown>[];
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}

export async function queryRecords(
  db: Database,
  view: RecordView,
  filters: RecordFilters,
  page: number,
  total: number,
  /** Optional so the existing five-argument callers keep their meaning. */
  pageSize?: number,
): Promise<RecordPage> {
  const from = sql.raw(`${pgIdentifier(view.schemaName)}.${pgIdentifier(view.viewName)}`);
  const size = clampPageSize(pageSize ?? RECORDS_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pageCount);

  const rows = (await db.execute(sql`
    SELECT v.*
    FROM ${from} v
    WHERE ${buildFilters(filters)}
    ORDER BY v.submitted_at DESC, v.submission_id
    LIMIT ${size}
    OFFSET ${(current - 1) * size}
  `)) as unknown as Record<string, unknown>[];

  return { rows, page: current, pageCount, total, pageSize: size };
}

/**
 * Every matching row, in batches, for the export.
 *
 * Batched rather than one query because an export is unbounded by nature — a
 * year of attendance for a large programme is a lot of rows to hold in memory
 * at once on a small serverless instance. Ordered identically to the on-screen
 * table so the download matches what the admin was looking at.
 */
export async function* streamRecords(
  db: Database,
  view: RecordView,
  filters: RecordFilters,
  batchSize = 1000,
): AsyncGenerator<Record<string, unknown>[]> {
  const from = sql.raw(`${pgIdentifier(view.schemaName)}.${pgIdentifier(view.viewName)}`);
  let offset = 0;

  for (;;) {
    const rows = (await db.execute(sql`
      SELECT v.*
      FROM ${from} v
      WHERE ${buildFilters(filters)}
      ORDER BY v.submitted_at DESC, v.submission_id
      LIMIT ${batchSize}
      OFFSET ${offset}
    `)) as unknown as Record<string, unknown>[];

    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batchSize) return;
    offset += batchSize;
  }
}
