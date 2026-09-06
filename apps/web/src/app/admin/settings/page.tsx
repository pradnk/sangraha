import { getOrgIdentity, getOrgSettings, missingForNotice } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { getOrgIdentityById } from '@/lib/org-identity';
import { IdentityForm } from './identity-form';
import { LogoSection } from './logo-section';
import { SettingsForm } from './settings-form';

export default async function SettingsPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const { settings, identity } = await withSession(session, async (tx) => ({
    settings: await getOrgSettings(tx, session.orgId),
    identity: await getOrgIdentity(tx, session.orgId),
  }));
  const org = await getOrgIdentityById(session.orgId);

  if (!settings || !identity || !org) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <h1 className="text-xl font-bold">Organisation</h1>
      <LogoSection org={org} />
      <SettingsForm settings={settings} locale={session.locale} />
      <IdentityForm identity={identity} missingFields={missingForNotice(identity)} />
    </div>
  );
}
