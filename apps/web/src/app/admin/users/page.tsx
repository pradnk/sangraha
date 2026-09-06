import { asc, eq } from 'drizzle-orm';
import { listUsers, locations } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { UsersManager } from './users-manager';

export default async function UsersPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const { people, places } = await withSession(session, async (tx) => ({
    people: await listUsers(tx, session.orgId),
    places: await tx
      .select({ id: locations.id, name: locations.name, level: locations.level })
      .from(locations)
      .where(eq(locations.orgId, session.orgId))
      .orderBy(asc(locations.path)),
  }));

  return (
    <UsersManager
      people={people}
      places={places}
      currentUserId={session.userId}
      locale={session.locale}
    />
  );
}
