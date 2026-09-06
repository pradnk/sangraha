import { eq } from 'drizzle-orm';
import type { DbLike } from '../client';
import { organisations } from '../schema/tenancy';

/**
 * Who an organisation is, in law.
 *
 * Under the DPDP Act the NGO is the Data Fiduciary and Sangraha is at most a
 * Data Processor, so every obligation a beneficiary can enforce runs against
 * the organisation — and a privacy notice that cannot name it, or say how to
 * complain to it, fails on its face.
 *
 * Kept apart from `getOrgSettings` deliberately. That is the working
 * configuration an admin changes when the programme changes; this is the legal
 * identity, changes almost never, and is the thing an auditor asks for.
 */

export interface OrgIdentity {
  legalName: string | null;
  entityType: string | null;
  registrationNumber: string | null;
  registeredAddress: string | null;
  grievanceOfficerName: string | null;
  grievanceOfficerEmail: string | null;
  grievanceOfficerPhone: string | null;
  dpoName: string | null;
  dpoEmail: string | null;
  dataRegion: string;
  isSignificantDataFiduciary: boolean;
}

const COLUMNS = {
  legalName: organisations.legalName,
  entityType: organisations.entityType,
  registrationNumber: organisations.registrationNumber,
  registeredAddress: organisations.registeredAddress,
  grievanceOfficerName: organisations.grievanceOfficerName,
  grievanceOfficerEmail: organisations.grievanceOfficerEmail,
  grievanceOfficerPhone: organisations.grievanceOfficerPhone,
  dpoName: organisations.dpoName,
  dpoEmail: organisations.dpoEmail,
  dataRegion: organisations.dataRegion,
  isSignificantDataFiduciary: organisations.isSignificantDataFiduciary,
} as const;

export async function getOrgIdentity(db: DbLike, orgId: string): Promise<OrgIdentity | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);

  return row ?? null;
}

export async function updateOrgIdentity(
  db: DbLike,
  orgId: string,
  patch: Partial<OrgIdentity>,
): Promise<void> {
  await db
    .update(organisations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(organisations.id, orgId));
}

/**
 * What is still missing before this organisation can publish a privacy notice.
 *
 * Returned as field names rather than sentences so the caller can both show the
 * wording in its own language and highlight the inputs. An empty array means
 * ready.
 *
 * A grievance route is the load-bearing one: DPDP gives a Data Principal the
 * right to complain to the Data Fiduciary *before* escalating to the Board, and
 * a notice with nowhere to complain to removes the first step. Either an email
 * or a phone number satisfies it — most NGOs here will give a phone, and
 * insisting on email would exclude exactly the organisations that need this
 * most.
 *
 * The DPO is deliberately not required: only a Significant Data Fiduciary must
 * appoint one, and demanding it of a four-person NGO teaches them that
 * compliance is theatre.
 */
export function missingForNotice(identity: OrgIdentity): (keyof OrgIdentity)[] {
  const missing: (keyof OrgIdentity)[] = [];
  const blank = (value: string | null) => !value || value.trim() === '';

  if (blank(identity.legalName)) missing.push('legalName');
  if (blank(identity.registeredAddress)) missing.push('registeredAddress');
  if (blank(identity.grievanceOfficerName)) missing.push('grievanceOfficerName');
  if (blank(identity.grievanceOfficerEmail) && blank(identity.grievanceOfficerPhone)) {
    missing.push('grievanceOfficerEmail');
  }
  if (identity.isSignificantDataFiduciary && blank(identity.dpoName)) missing.push('dpoName');

  return missing;
}
