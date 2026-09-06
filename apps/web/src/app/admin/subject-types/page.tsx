import { listRegistrationFields, listSubjectTypes } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { SubjectTypesManager } from './subject-types-manager';

/**
 * What this organisation registers.
 *
 * The screen that was missing: `/admin/forms/new` could create a registration
 * form but never asked what it registered, so every form built through the UI
 * had no subject type and the registry could not work at all.
 */
export default async function SubjectTypesPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const { types, fieldsByType } = await withSession(session, async (tx) => {
    const all = await listSubjectTypes(tx, session.orgId);

    // The answers each type can be named or matched on, read from its own
    // registration form.
    const entries = await Promise.all(
      all.map(async (type) => [
        type.id,
        await listRegistrationFields(tx, session.orgId, type.id),
      ] as const),
    );

    return { types: all, fieldsByType: Object.fromEntries(entries) };
  });

  return (
    <SubjectTypesManager types={types} fieldsByType={fieldsByType} locale={session.locale} />
  );
}
