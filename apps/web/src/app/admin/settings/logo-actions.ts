'use server';

import { revalidatePath } from 'next/cache';
import {
  ALLOWED_LOGO_MIMES,
  MAX_LOGO_BYTES,
  removeOrgLogo,
  setOrgLogo,
  type SetLogoResult,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

export interface LogoState {
  error?: string;
  ok?: boolean;
}

/**
 * Uploads an organisation's logo.
 *
 * Taken as a plain form upload rather than a presigned direct-to-storage flow:
 * it is one small file, uploaded once, and the round trip through the server is
 * what lets the size and type be checked before anything is stored.
 */
export async function uploadLogoAction(
  previousOrFormData: LogoState | FormData,
  maybeFormData?: FormData,
): Promise<LogoState> {
  const formData =
    maybeFormData instanceof FormData
      ? maybeFormData
      : previousOrFormData instanceof FormData
        ? previousOrFormData
        : undefined;
  if (!formData) return { error: 'Something went wrong. Please try again.' };

  const session = await requireRole(['org_admin', 'super_admin']);

  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose an image file to upload.' };
  }

  /*
   * The browser resizes to well under this before sending, so reaching here
   * means either an unusual image or a request that did not come from our form.
   * Either way it is the boundary, not the form, that decides.
   */
  if (file.size > MAX_LOGO_BYTES) {
    return {
      error: `That image is ${Math.round(file.size / 1024)} KB, which is larger than the ${Math.round(MAX_LOGO_BYTES / 1024)} KB limit. Reload the page and try again — the app normally resizes images for you.`,
    };
  }

  if (!ALLOWED_LOGO_MIMES.includes(file.type as never)) {
    return { error: 'Please upload a PNG, JPG or WebP image. SVG files are not accepted.' };
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  const result = await withSession<SetLogoResult>(session, (tx) =>
    setOrgLogo(tx, session.orgId, { mime: file.type, bytes }),
  );

  if (!result.ok) {
    return { error: 'That image could not be saved. Try a different file.' };
  }

  // The logo is in every header, so the whole tree is stale.
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function removeLogoAction(): Promise<LogoState> {
  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => removeOrgLogo(tx, session.orgId));

  revalidatePath('/', 'layout');
  return { ok: true };
}
