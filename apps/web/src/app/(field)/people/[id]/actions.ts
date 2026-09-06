'use server';

import { revalidatePath } from 'next/cache';
import { markAsDuplicate, unmarkDuplicate } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

/**
 * Linking two records as the same person — and unlinking them again.
 *
 * Deliberately not a merge. A merge has to pick which of two conflicting values
 * survives and then destroys the other, which is not something to do to a
 * beneficiary record on the strength of a similar name. Both rows stay; one
 * points at the other; the pointer can be removed.
 */

export interface LinkState {
  error?: string;
  ok?: boolean;
}

/** Supervisors and admins only. A field worker sees the button on neither path. */
const ALLOWED = ['supervisor', 'org_admin', 'super_admin'] as const;

export async function markDuplicateAction(
  subjectId: string,
  canonicalId: string,
): Promise<LinkState> {
  const session = await requireRole([...ALLOWED]);

  const result = await withSession(session, (tx) =>
    markAsDuplicate(tx, { subjectId, canonicalId, markedBy: session.userId }),
  );

  if (!result.ok) return { error: result.reason };

  revalidatePath(`/people/${subjectId}`);
  revalidatePath(`/people/${canonicalId}`);
  return { ok: true };
}

export async function unmarkDuplicateAction(subjectId: string): Promise<LinkState> {
  const session = await requireRole([...ALLOWED]);

  await withSession(session, (tx) => unmarkDuplicate(tx, subjectId));

  revalidatePath(`/people/${subjectId}`);
  return { ok: true };
}
