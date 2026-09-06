'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  createNotice,
  discardNotice,
  decideOverride,
  getOwnerDb,
  createPurpose,
  generateNoticeDraft,
  getOrCreateNoticeDraft,
  isOverrideVisible,
  publishNotice,
  retractNoticeVersion,
  setNoticePurposes,
  updateNoticeDraft,
  updatePurpose,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

export interface PrivacyState {
  ok?: boolean;
  error?: string;
  /** Named so the screen can point at what is missing rather than counting it. */
  missing?: string[];
}

const i18n = z.record(z.string().max(20_000));

const LAWFUL_BASES = [
  'consent',
  'guardian_consent',
  'voluntary',
  'state_benefit',
  'medical_emergency',
  'employment',
] as const;

export async function createPurposeAction(input: {
  name: string;
  lawfulBasis?: (typeof LAWFUL_BASES)[number];
}): Promise<PrivacyState> {
  const parsed = z
    .object({ name: z.string().min(3).max(200), lawfulBasis: z.enum(LAWFUL_BASES).optional() })
    .safeParse(input);
  if (!parsed.success) return { error: 'Give the purpose a name of at least three characters.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) =>
    createPurpose(tx, session.orgId, {
      name: { en: parsed.data.name },
      lawfulBasis: parsed.data.lawfulBasis ?? 'consent',
    }),
  );

  revalidatePath('/admin/privacy');
  return { ok: true };
}

export async function updatePurposeAction(
  id: string,
  patch: {
    name?: Record<string, string>;
    description?: Record<string, string>;
    lawfulBasis?: (typeof LAWFUL_BASES)[number];
    retentionMonths?: number | null;
    retentionStatute?: string | null;
  },
): Promise<PrivacyState> {
  const parsed = z
    .object({
      name: i18n.optional(),
      description: i18n.optional(),
      lawfulBasis: z.enum(LAWFUL_BASES).optional(),
      // A retention of zero means "delete immediately", which is a real answer;
      // negative is not.
      retentionMonths: z.number().int().min(0).max(1200).nullable().optional(),
      retentionStatute: z.string().max(200).nullable().optional(),
    })
    .safeParse(patch);
  if (!parsed.success) return { error: 'That could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => updatePurpose(tx, session.orgId, id, parsed.data));

  revalidatePath('/admin/privacy');
  return { ok: true };
}

export async function createNoticeAction(name: string): Promise<PrivacyState> {
  const parsed = z.string().min(3).max(200).safeParse(name);
  if (!parsed.success) return { error: 'Give the notice a name.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => createNotice(tx, session.orgId, { name: { en: parsed.data } }));

  revalidatePath('/admin/privacy');
  return { ok: true };
}

/**
 * Throws away a notice nobody has ever been read.
 *
 * Refuses once it has been published, because a published version is what a
 * consent record cites as "these were the words". `slug` is derived from the
 * name and immutable, so this is also how a badly-named first attempt gets
 * fixed: discard it and start again.
 */
export async function discardNoticeAction(noticeId: string): Promise<PrivacyState> {
  const parsed = z.string().uuid().safeParse(noticeId);
  if (!parsed.success) return { error: 'That notice could not be found.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  const result = await withSession(session, (tx) =>
    discardNotice(tx, session.orgId, parsed.data),
  );

  if (!result.ok) {
    return {
      error:
        result.reason === 'published'
          ? 'This one has been published, so it is kept — it is the record of what people were told. Publish a new version instead.'
          : 'That notice could not be found.',
    };
  }

  revalidatePath('/admin/privacy');
  return { ok: true };
}

/**
 * Writes a first draft from the forms the organisation already publishes.
 *
 * `force` is a separate, differently-worded button. Regenerating over words an
 * administrator wrote is destructive and must never be the thing that happens
 * when they meant "top up the languages I have not filled in".
 */
export async function generateNoticeAction(
  noticeId: string,
  force = false,
): Promise<PrivacyState> {
  const session = await requireRole(['org_admin', 'super_admin']);

  const result = await withSession(session, async (tx) => {
    const versionId = await getOrCreateNoticeDraft(tx, noticeId, session.userId);
    return generateNoticeDraft(tx, session.orgId, versionId, { force });
  });

  revalidatePath('/admin/privacy');
  if (!result.ok) {
    return {
      error: 'Fill in your organisation’s legal details first — a notice has to name you.',
      missing: result.missing,
    };
  }
  return { ok: true };
}

export async function saveNoticeDraftAction(
  noticeId: string,
  body: Record<string, string>,
  purposeIds: string[],
): Promise<PrivacyState> {
  const parsed = z
    .object({ body: i18n, purposeIds: z.array(z.string().uuid()).max(50) })
    .safeParse({ body, purposeIds });
  if (!parsed.success) return { error: 'That could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, async (tx) => {
    const versionId = await getOrCreateNoticeDraft(tx, noticeId, session.userId);
    await updateNoticeDraft(tx, versionId, { body: parsed.data.body });
    await setNoticePurposes(tx, versionId, parsed.data.purposeIds);
  });

  revalidatePath('/admin/privacy');
  return { ok: true };
}

const PUBLISH_REFUSALS: Record<string, string> = {
  no_draft: 'There is nothing to publish — this notice has no unsaved changes.',
  empty: 'Write the notice first. A blank notice cannot be read out to anybody.',
  no_purposes:
    'Say what this notice covers. People agree to a purpose, so there has to be at least one.',
  organisation_incomplete:
    'Fill in your organisation’s legal details first — a notice has to name you and say how to complain.',
};

export async function publishNoticeAction(noticeId: string): Promise<PrivacyState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  const result = await withSession(session, (tx) =>
    publishNotice(tx, session.orgId, noticeId, session.userId),
  );

  revalidatePath('/admin/privacy');
  if (!result.ok) {
    return { error: PUBLISH_REFUSALS[result.reason] ?? 'That could not be published.', missing: result.missing };
  }
  return { ok: true };
}

export async function retractNoticeAction(versionId: string): Promise<PrivacyState> {
  const parsed = z.string().uuid().safeParse(versionId);
  if (!parsed.success) return { error: 'Unknown version.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => retractNoticeVersion(tx, parsed.data));

  revalidatePath('/admin/privacy');
  return { ok: true };
}

/**
 * A supervisor deciding on a child recorded without a guardian.
 *
 * Note it never marks the guardian as verified. Approving records that somebody
 * senior looked at the gap and accepted it with a reason — it does not conjure
 * a guardian who was not there. The row stays visibly irregular and keeps being
 * counted, which is what makes this an exception rather than a permission.
 *
 * Runs on the owner connection: this is the one legitimate write to an existing
 * consent row, and the guard in `015-immutability.sql` refuses every update but
 * a redaction unless the caller declares itself.
 *
 * Which means Row-Level Security is not scoping that statement, so the event is
 * re-read under the caller's own context first — exactly as `clearGuardianFlag`
 * does for the same decision on the review screen. Without it the only thing
 * standing between a supervisor and another organisation's consent log is
 * knowing a uuid.
 */
export async function decideOverrideAction(
  eventId: string,
  reason: string,
): Promise<PrivacyState> {
  const parsed = z
    .object({
      eventId: z.string().uuid(),
      // A minimum length, because "ok" is not a reason and a picklist would
      // have produced "Other" ninety-five per cent of the time.
      reason: z.string().trim().min(10).max(1000),
    })
    .safeParse({ eventId, reason });
  if (!parsed.success) {
    return { error: 'Say in a sentence why this record has no guardian. It is kept and counted.' };
  }

  const session = await requireRole(['supervisor', 'org_admin', 'super_admin']);

  const visible = await withSession(session, (tx) =>
    isOverrideVisible(tx, session.orgId, parsed.data.eventId),
  );
  if (!visible) return { error: 'That record is no longer here.' };

  await getOwnerDb().transaction(async (tx) => {
    await decideOverride(tx, parsed.data.eventId, {
      by: session.userId,
      role: session.role,
      reason: parsed.data.reason,
    });
  });

  revalidatePath('/admin/privacy');
  revalidatePath('/review');
  return { ok: true };
}
