import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbLike } from '../client';
import { formAccess, forms, users } from '../schema/index';

/**
 * Who may use a form. Each value names the lowest role included automatically;
 * `supervisors` and `admins` take individually named people on top.
 */
export type FormAudience = 'everyone' | 'supervisors' | 'admins';

/**
 * Restricts a query over `forms` to the ones the caller may use.
 *
 * One definition, shared by every screen that lists forms, and the same function
 * the policies call — so what a worker is shown and what the database will
 * accept from them cannot drift apart.
 *
 * The column is written out rather than interpolated. Drizzle renders
 * `${forms.id}` as a bare `"id"`, which is fine in a single-table query and
 * binds to the wrong table the moment somebody adds a join. Qualifying it now
 * costs nothing and removes the trap.
 */
export function usableForm(): SQL {
  return sql`app.can_use_form("forms"."id")`;
}

export interface FormAudienceState {
  audience: FormAudience;
  /** Ids named on the form. Ignored while the audience is `everyone`. */
  userIds: string[];
}

/** The form's audience and, when it has one, the people named on it. */
export async function getFormAudience(db: DbLike, formId: string): Promise<FormAudienceState> {
  const [form] = await db
    .select({ audience: forms.audience })
    .from(forms)
    .where(eq(forms.id, formId))
    .limit(1);

  const named = await db
    .select({ userId: formAccess.userId })
    .from(formAccess)
    .where(eq(formAccess.formId, formId));

  return {
    audience: (form?.audience ?? 'everyone') as FormAudience,
    userIds: named.map((row: { userId: string }) => row.userId),
  };
}

export type SetAudienceResult = { ok: true } | { ok: false; reason: 'unknown_form' };

/**
 * Sets who may use a form.
 *
 * Belongs to the form rather than to a draft version, so it takes effect
 * immediately without a publish — the same reasoning as `setFormSubjectType`.
 * An admin narrowing a form mid-campaign wants that to be true now, not after
 * they remember to press Publish.
 *
 * **Every user id is re-resolved against the organisation inside the
 * transaction.** The ids arrive from a browser; without this a hand-edited
 * request could name another tenant's user, and `form_access` has no `org_id`
 * of its own to catch it. Unknown ids are dropped rather than refused: the
 * realistic cause is a stale page listing somebody who has since been deleted,
 * and failing the whole save over that would leave the admin unable to change
 * anything.
 *
 * Replace-all, as the location assignments do. Rows are written for either
 * restricted tier and **kept** when the form is opened to everyone: an admin who
 * widens a form for a campaign and narrows it again should find their list where
 * they left it.
 */
export async function setFormAudience(
  db: DbLike,
  input: {
    formId: string;
    orgId: string;
    audience: FormAudience;
    userIds: string[];
  },
): Promise<SetAudienceResult> {
  const [form] = await db
    .select({ id: forms.id })
    .from(forms)
    .where(and(eq(forms.id, input.formId), eq(forms.orgId, input.orgId)))
    .limit(1);

  if (!form) return { ok: false, reason: 'unknown_form' };

  await db.update(forms).set({ audience: input.audience }).where(eq(forms.id, input.formId));

  if (input.audience !== 'everyone') {
    const permitted =
      input.userIds.length > 0
        ? await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.orgId, input.orgId), inArray(users.id, input.userIds)))
        : [];

    await db.delete(formAccess).where(eq(formAccess.formId, input.formId));

    if (permitted.length > 0) {
      await db
        .insert(formAccess)
        .values(permitted.map((row: { id: string }) => ({ formId: input.formId, userId: row.id })));
    }
  }

  return { ok: true };
}
