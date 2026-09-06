import Link from 'next/link';
import { CalendarPlus, ClipboardList, FileText } from 'lucide-react';
import { and, asc, eq } from 'drizzle-orm';
import { forms } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';

/**
 * The field home screen.
 *
 * Forms, and nothing else. Everything that is not filling one in — finding a
 * person, what I have sent, approving field data, managing forms — moved behind
 * the menu in the header, because those four never grow and the forms do. They
 * used to sit underneath the form cards, so each new form pushed them further
 * down until an admin could not find "Manage forms" at all.
 *
 * Grouped by what a form is *for* rather than listed flat: registering somebody
 * and recording a visit are different acts, and the distinction is already how
 * the product thinks about forms. A heading costs one line at three forms and
 * earns its place at thirty.
 */
export default async function FieldHome() {
  const session = await requireSession();

  const available = await withSession(session, (tx) =>
    tx
      .select({ slug: forms.slug, name: forms.name, formType: forms.formType })
      .from(forms)
      .where(and(eq(forms.orgId, session.orgId), eq(forms.isActive, true)))
      .orderBy(asc(forms.slug)),
  );

  const groups = [
    {
      key: 'registration' as const,
      heading: m(session.locale, 'registerSomeone'),
      icon: <ClipboardList aria-hidden className="h-8 w-8" />,
      tone: 'primary' as const,
    },
    {
      key: 'encounter' as const,
      heading: m(session.locale, 'recordAVisit'),
      icon: <CalendarPlus aria-hidden className="h-8 w-8" />,
      tone: 'neutral' as const,
    },
    {
      key: 'standalone' as const,
      heading: m(session.locale, 'oneOffRecords'),
      icon: <FileText aria-hidden className="h-8 w-8" />,
      tone: 'neutral' as const,
    },
  ].map((group) => ({
    ...group,
    forms: available.filter((form) => form.formType === group.key),
  }));

  const shown = groups.filter((group) => group.forms.length > 0);

  return (
    <div className="flex flex-col gap-6 px-5 py-6">
      <h1 className="sr-only">{m(session.locale, 'home')}</h1>

      {available.length === 0 ? (
        <p className="rounded-field bg-slate-100 p-5 text-field-base text-slate-700">
          {m(session.locale, 'noFormsYet')}
        </p>
      ) : null}

      {shown.map((group) => (
        <section key={group.key} className="flex flex-col gap-3">
          {/* Only headed when there is more than one kind. A single group needs
              no label to tell it apart from anything. */}
          {shown.length > 1 ? (
            <h2 className="text-field-sm font-semibold uppercase tracking-wide text-slate-500">
              {group.heading}
            </h2>
          ) : null}

          {group.forms.map((form) => (
            <Link
              key={form.slug}
              href={`/forms/${form.slug}`}
              className={
                group.tone === 'primary'
                  ? 'flex min-h-[6rem] items-center gap-4 rounded-field bg-brand-600 px-5 py-4 text-field-lg font-semibold text-white'
                  : 'flex min-h-[6rem] items-center gap-4 rounded-field border-2 border-slate-300 bg-white px-5 py-4 text-field-lg font-semibold text-slate-900'
              }
            >
              {group.icon}
              <span className="flex-1">{t(form.name, session.locale, form.slug)}</span>
            </Link>
          ))}
        </section>
      ))}
    </div>
  );
}
