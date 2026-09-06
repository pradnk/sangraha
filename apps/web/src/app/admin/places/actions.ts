'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  addLocation,
  deleteLocation,
  renameLocation,
  setLocationActive,
  updateOrgSettings,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { UI_LOCALES } from '@/lib/i18n';

export interface PlacesState {
  error?: string;
  ok?: boolean;
}

const i18nText = z.record(z.string().max(200));

export async function addPlaceAction(
  parentId: string | null,
  name: string,
): Promise<PlacesState> {
  const parsed = z
    .object({ parentId: z.string().uuid().nullable(), name: z.string().min(1).max(200) })
    .safeParse({ parentId, name });
  if (!parsed.success) return { error: 'Give the place a name.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) =>
    addLocation(tx, session.orgId, { parentId: parsed.data.parentId, name: { en: parsed.data.name } }),
  );

  revalidatePath('/admin/places');
  return { ok: true };
}

export async function renamePlaceAction(
  id: string,
  name: Record<string, string>,
  externalCode: string | null,
): Promise<PlacesState> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      name: i18nText,
      externalCode: z.string().max(80).nullable(),
    })
    .safeParse({ id, name, externalCode });
  if (!parsed.success) return { error: 'That change could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) =>
    renameLocation(tx, parsed.data.id, parsed.data.name, parsed.data.externalCode),
  );

  revalidatePath('/admin/places');
  return { ok: true };
}

export async function setPlaceActiveAction(id: string, isActive: boolean): Promise<PlacesState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => setLocationActive(tx, id, isActive));

  revalidatePath('/admin/places');
  return { ok: true };
}

export async function deletePlaceAction(id: string): Promise<PlacesState> {
  const session = await requireRole(['org_admin', 'super_admin']);

  const result = await withSession(session, (tx) => deleteLocation(tx, id));
  if (!result.ok) return { error: result.reason };

  revalidatePath('/admin/places');
  return { ok: true };
}

export async function updateOrgSettingsAction(patch: {
  name?: string;
  enabledLocales?: string[];
  locationLevels?: { key: string; label: Record<string, string> }[];
}): Promise<PlacesState> {
  const parsed = z
    .object({
      name: z.string().min(1).max(200).optional(),
      // Only languages the product actually ships strings for; anything else
      // would show a worker English while claiming otherwise.
      enabledLocales: z.array(z.enum(UI_LOCALES)).min(1).optional(),
      locationLevels: z
        .array(z.object({ key: z.string().min(1).max(40), label: i18nText }))
        .max(6)
        .optional(),
    })
    .safeParse(patch);
  if (!parsed.success) return { error: 'Those settings could not be saved.' };

  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => updateOrgSettings(tx, session.orgId, parsed.data));

  revalidatePath('/admin/places');
  revalidatePath('/admin/settings');
  return { ok: true };
}
