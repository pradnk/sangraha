import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { DbLike } from '../client';
import { accessEvents } from '../schema/compliance';
import { users } from '../schema/tenancy';

/**
 * Recording who looked at personal data.
 *
 * One row per act, never per row of data — see the note on the table itself.
 *
 * **Give this its own transaction. Never the caller's.** The swallow below
 * looks like it makes logging safe to inline anywhere, and it does not:
 * Postgres aborts an entire transaction on any failed statement, and postgres.js
 * re-raises at the commit boundary even after a savepoint rollback. Catching
 * the error here cannot undo either. So a failed audit insert sharing a
 * transaction with a submission would roll the submission back — the log
 * destroying the very record it exists to account for.
 *
 * The catch is therefore the *second* line of defence. The first is the caller
 * handing over a connection of its own; `logAccess` in the web app does that,
 * and wraps this again on the outside.
 *
 * That the write can fail silently is a deliberate trade rather than an
 * oversight. A logging outage that takes down the Records screen protects
 * nobody, and a field worker who cannot find a beneficiary because an audit
 * insert failed is a real harm traded for a hypothetical one. The consequence
 * is that this log is evidence of what *was* seen, not proof of everything that
 * was.
 */

export interface AccessActor {
  orgId: string;
  userId: string;
  username?: string | null;
  role?: string | null;
}

export type AccessAction =
  | 'export_csv'
  | 'view_subject'
  | 'view_record'
  | 'view_records'
  | 'search_subjects'
  | 'check_duplicates'
  | 'sign_in';

export interface AccessEventInput {
  action: AccessAction;
  targetType?: 'form' | 'subject' | 'submission' | 'organisation' | null;
  targetId?: string | null;
  /** How many people's data this act touched. Null where it does not apply. */
  rowCount?: number | null;
  /** The filters in force — the query string, verbatim. */
  scope?: string | null;
}

export async function recordAccess(
  db: DbLike,
  actor: AccessActor,
  event: AccessEventInput,
): Promise<void> {
  try {
    await db.insert(accessEvents).values({
      orgId: actor.orgId,
      actorId: actor.userId,
      actorUsername: actor.username ?? null,
      actorRole: actor.role ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      rowCount: event.rowCount ?? null,
      scope: event.scope ?? null,
    });
  } catch (error) {
    /*
     * Reported rather than silently dropped, so a persistent failure is visible
     * in the server output instead of showing up as an inexplicably empty audit
     * trail months later.
     */
    console.error('[access-log] failed to record', event.action, error);
  }
}

export interface AccessEntry {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorUsername: string | null;
  actorRole: string | null;
  action: AccessAction;
  targetType: string | null;
  targetId: string | null;
  rowCount: number | null;
  scope: string | null;
  at: Date;
}

export interface AccessLogFilters {
  actorId?: string | null;
  action?: AccessAction | null;
  targetId?: string | null;
  /** Inclusive, as a date somebody typed. */
  since?: string | null;
}

/**
 * The oversight view: what has been happening, newest first.
 *
 * `org_admin` only, enforced by the RLS policy rather than here — a log a field
 * worker can read tells them which colleague has been checked on.
 */
export async function listAccessEvents(
  db: DbLike,
  filters: AccessLogFilters = {},
  limit = 100,
): Promise<AccessEntry[]> {
  const where = [
    filters.actorId ? eq(accessEvents.actorId, filters.actorId) : undefined,
    filters.action ? eq(accessEvents.action, filters.action) : undefined,
    filters.targetId ? eq(accessEvents.targetId, filters.targetId) : undefined,
    filters.since ? gte(accessEvents.at, new Date(filters.since)) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: accessEvents.id,
      actorId: accessEvents.actorId,
      // Live name where the account still exists, snapshot otherwise.
      actorName: users.fullName,
      actorUsername: accessEvents.actorUsername,
      actorRole: accessEvents.actorRole,
      action: accessEvents.action,
      targetType: accessEvents.targetType,
      targetId: accessEvents.targetId,
      rowCount: accessEvents.rowCount,
      scope: accessEvents.scope,
      at: accessEvents.at,
    })
    .from(accessEvents)
    .leftJoin(users, eq(users.id, accessEvents.actorId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(accessEvents.at))
    .limit(Math.min(limit, 500));

  return rows as AccessEntry[];
}

/**
 * Everything that touched one person's data.
 *
 * The question a breach report has to answer, and the reason the target index
 * is on `(org_id, target_type, target_id)`. An export is included even though
 * it names no individual: `rowCount` and `scope` say a file went out that this
 * person was probably in, which is what has to be disclosed.
 */
export async function accessTouchingSubject(
  db: DbLike,
  orgId: string,
  subjectId: string,
): Promise<AccessEntry[]> {
  const rows = (await db.execute(sql`
    SELECT
      a.id, a.actor_id, u.full_name AS actor_name, a.actor_username, a.actor_role,
      a.action::text AS action, a.target_type, a.target_id, a.row_count, a.scope, a.at
    FROM access_events a
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.org_id = ${orgId}
      AND (
        (a.target_type = 'subject' AND a.target_id = ${subjectId}::uuid)
        -- A bulk act has no single target, but the person was in it.
        OR a.action IN ('export_csv', 'view_records', 'search_subjects')
      )
    ORDER BY a.at DESC
    LIMIT 500
  `)) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    actorId: (row.actor_id as string) ?? null,
    actorName: (row.actor_name as string) ?? null,
    actorUsername: (row.actor_username as string) ?? null,
    actorRole: (row.actor_role as string) ?? null,
    action: row.action as AccessAction,
    targetType: (row.target_type as string) ?? null,
    targetId: (row.target_id as string) ?? null,
    rowCount: (row.row_count as number) ?? null,
    scope: (row.scope as string) ?? null,
    at: new Date(row.at as string),
  }));
}
