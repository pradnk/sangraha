import { listSubjectTypes } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { ImportWizard } from './import-wizard';

/**
 * Bringing an organisation's existing records in.
 *
 * The migration path off Excel, and the reason it matters: until the years of
 * history already in a spreadsheet are here too, this is a second place to look
 * rather than the place to look. Building the *form* out of their own column
 * headings is half the point — their team already knows those words.
 */
export default async function ImportPage() {
  const session = await requireRole(['org_admin', 'super_admin']);

  const subjectTypes = await withSession(session, (tx) =>
    listSubjectTypes(tx, session.orgId),
  );

  return (
    <ImportWizard
      subjectTypes={subjectTypes
        .filter((type) => type.isActive)
        .map((type) => ({ id: type.id, name: type.name, code: type.code }))}
      locale={session.locale}
    />
  );
}
