import Link from 'next/link';
import { AlertTriangle, CircleDashed, Plus } from 'lucide-react';
import { listFormsForAdmin } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';

const FORM_TYPE_LABELS: Record<string, string> = {
  registration: 'Registers a person',
  encounter: 'Records a visit',
  standalone: 'Standalone',
};

export default async function AdminFormsPage() {
  const session = await requireRole(['org_admin', 'super_admin']);
  const forms = await withSession(session, (tx) => listFormsForAdmin(tx, session.orgId));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Forms</h1>
        <Link
          href="/admin/forms/new"
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
        >
          <Plus aria-hidden className="h-4 w-4" />
          New form
        </Link>
      </div>

      {forms.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-600">
          No forms yet. Create one to start collecting data.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Form</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Who can use it</th>
                <th className="px-4 py-2.5 font-medium">Published</th>
                <th className="px-4 py-2.5 text-right font-medium">Responses</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {forms.map((form) => (
                <tr key={form.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/forms/${form.slug}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {t(form.name, session.locale, form.slug)}
                    </Link>
                    <p className="font-mono text-xs text-slate-400">{form.slug}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {FORM_TYPE_LABELS[form.formType] ?? form.formType}
                    {/* A form that is about a person but never said which kind
                        registers nobody. It used to fail in silence — the
                        worker filled it in and nobody appeared in the
                        registry — so it is called out here. */}
                    {form.missingSubjectType ? (
                      <span className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-700">
                        <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
                        No one chosen — registers nobody
                      </span>
                    ) : null}
                  </td>
                  {/* Who may use it, so an admin can see at a glance which
                      forms have been narrowed without opening each one. */}
                  <td className="px-4 py-3 text-slate-600">
                    {form.audience === 'everyone'
                      ? 'Everyone'
                      : form.audience === 'supervisors'
                        ? `Supervisors${form.namedCount ? ` + ${form.namedCount}` : ''}`
                        : `Admins${form.namedCount ? ` + ${form.namedCount}` : ''}`}
                  </td>
                  <td className="px-4 py-3">
                    {form.publishedVersion ? (
                      <span className="text-slate-700">Version {form.publishedVersion}</span>
                    ) : (
                      <span className="text-slate-400">Not published</span>
                    )}
                    {/* Unpublished changes are the thing an admin most often
                        forgets, so they are called out on the list, not just
                        inside the editor. */}
                    {form.hasDraft ? (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        <CircleDashed aria-hidden className="h-3 w-3" />
                        Unpublished changes
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                    {form.submissionCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
