'use server';

import { revalidatePath } from 'next/cache';
import { dismissSetupGuide } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';

/**
 * Hides the getting-started banner.
 *
 * Only the banner. The guide itself stays reachable, because "I finished setup"
 * and "I never want to see that page again" are different things.
 */
export async function dismissSetupAction(): Promise<void> {
  const session = await requireRole(['org_admin', 'super_admin']);
  await withSession(session, (tx) => dismissSetupGuide(tx, session.orgId));

  revalidatePath('/admin', 'layout');
}
