'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  addOption,
  countAnswersForOption,
  createOptionSet,
  deleteOption,
  getOptionSet,
  renameOptionSet,
  reorderOptions,
  setOptionActive,
  updateOptionLabel,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

export interface ListsState {
  error?: string;
  ok?: boolean;
}

const i18nText = z.record(z.string().max(200));

export async function createListAction(name: string): Promise<ListsState> {
  const parsed = z.string().min(1).max(120).safeParse(name);
  if (!parsed.success) return { error: 'Give the list a name.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => createOptionSet(tx, session.orgId, { en: parsed.data }));

  revalidatePath('/admin/lists');
  return { ok: true };
}

export async function renameListAction(id: string, name: Record<string, string>): Promise<ListsState> {
  const parsed = z.object({ id: z.string().uuid(), name: i18nText }).safeParse({ id, name });
  if (!parsed.success) return { error: 'That change could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => renameOptionSet(tx, parsed.data.id, parsed.data.name));

  revalidatePath('/admin/lists');
  return { ok: true };
}

export async function addOptionAction(setId: string, label: string): Promise<ListsState> {
  const parsed = z
    .object({ setId: z.string().uuid(), label: z.string().min(1).max(200) })
    .safeParse({ setId, label });
  if (!parsed.success) return { error: 'Give the answer a name.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => addOption(tx, parsed.data.setId, { en: parsed.data.label }));

  revalidatePath('/admin/lists');
  return { ok: true };
}

export async function relabelOptionAction(
  optionId: string,
  label: Record<string, string>,
): Promise<ListsState> {
  const parsed = z
    .object({ optionId: z.string().uuid(), label: i18nText })
    .safeParse({ optionId, label });
  if (!parsed.success) return { error: 'That change could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  // Only the label moves. The code is the analytics identity and is never
  // regenerated from a changed label.
  await withSession(session, (tx) => updateOptionLabel(tx, parsed.data.optionId, parsed.data.label));

  revalidatePath('/admin/lists');
  return { ok: true };
}

export async function setOptionActiveAction(
  optionId: string,
  isActive: boolean,
): Promise<ListsState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => setOptionActive(tx, optionId, isActive));

  revalidatePath('/admin/lists');
  return { ok: true };
}

/**
 * Deletes an answer, or refuses because it has been used.
 *
 * Same shape as deleting a question: refuse and offer retirement, because a
 * code that appears in stored submissions has to stay interpretable. Deleting
 * it would leave those answers showing a bare code with no meaning attached.
 */
export async function deleteOptionAction(
  setId: string,
  optionId: string,
): Promise<ListsState> {
  const session = await requireRole(['org_admin', 'super_admin']);

  return withSession(session, async (tx) => {
    const set = await getOptionSet(tx, session.orgId, setId);
    const option = set?.options.find((o) => o.id === optionId);
    if (!option) return { error: 'That answer no longer exists.' };

    const used = await countAnswersForOption(tx, session.orgId, setId, option.code);
    if (used > 0) {
      return {
        error: `${used} ${used === 1 ? 'record has' : 'records have'} this answer already. Deleting it would leave those records showing nothing. Hide it instead — field workers stop seeing it, and the records keep their meaning.`,
      };
    }

    await deleteOption(tx, optionId);
    revalidatePath('/admin/lists');
    return { ok: true };
  });
}

export async function reorderOptionsAction(
  setId: string,
  orderedIds: string[],
): Promise<ListsState> {
  const parsed = z
    .object({ setId: z.string().uuid(), orderedIds: z.array(z.string().uuid()) })
    .safeParse({ setId, orderedIds });
  if (!parsed.success) return { error: 'That change could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => reorderOptions(tx, parsed.data.setId, parsed.data.orderedIds));

  revalidatePath('/admin/lists');
  return { ok: true };
}
