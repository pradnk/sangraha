import { getLocationLevels, listLocations } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { PlacesManager } from './places-manager';

export default async function PlacesPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const { places, levels } = await withSession(session, async (tx) => ({
    places: await listLocations(tx, session.orgId),
    levels: await getLocationLevels(tx, session.orgId),
  }));

  return <PlacesManager places={places} levels={levels} locale={session.locale} />;
}
