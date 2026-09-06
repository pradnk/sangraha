import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { listSubjectTypes } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { NewFormForm } from './new-form-form';

export default async function NewFormPage() {
  const session = await requireRole(['org_admin', 'super_admin']);
  const subjectTypes = await withSession(session, (tx) =>
    listSubjectTypes(tx, session.orgId),
  );

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
      <Link
        href="/admin/forms"
        className="inline-flex items-center gap-1.5 self-start text-brand-700 hover:underline"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Forms
      </Link>

      <h1 className="text-xl font-bold">New form</h1>
      <NewFormForm
        subjectTypes={subjectTypes
          .filter((type) => type.isActive)
          .map((type) => ({ id: type.id, name: type.name, code: type.code }))}
        locale={session.locale}
      />
    </div>
  );
}
