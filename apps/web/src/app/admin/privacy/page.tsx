import {
  consentSummary,
  holdsBlocking,
  listErasureRequests,
  getOrgIdentity,
  listNotices,
  listPurposes,
  missingForNotice,
  pendingOverrides,
  unattributedFields,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { PrivacyManager } from './privacy-manager';

/**
 * Privacy: what you collect, why, and what you tell people.
 *
 * The screen an NGO administrator uses to become compliant rather than to read
 * about compliance. Two things live here — the list of purposes, and the notice
 * generated from them — because they are one job: you cannot write the notice
 * without knowing the purposes, and a purpose with no notice is never
 * explained to anybody.
 */
export default async function PrivacyPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const { purposes, notices, gaps, identity, summary, overrides, erasures, holds } = await withSession(
    session,
    async (tx) => ({
      purposes: await listPurposes(tx, session.orgId),
      notices: await listNotices(tx, session.orgId),
      gaps: await unattributedFields(tx, session.orgId),
      identity: await getOrgIdentity(tx, session.orgId),
      summary: await consentSummary(tx, session.orgId),
      overrides: await pendingOverrides(tx, session.orgId),
      erasures: await listErasureRequests(tx, session.orgId),
      holds: await holdsBlocking(tx, session.orgId),
    }),
  );

  return (
    <PrivacyManager
      purposes={purposes}
      notices={notices}
      unattributed={gaps}
      identityMissing={identity ? missingForNotice(identity) : ['legalName']}
      summary={summary}
      overrides={overrides}
      erasures={erasures}
      holds={holds}
      locale={session.locale}
    />
  );
}
