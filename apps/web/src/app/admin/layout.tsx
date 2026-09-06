import Link from 'next/link';
import { ArrowLeft, CircleUserRound } from 'lucide-react';
import { getSetupProgress } from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { getOrgIdentityById } from '@/lib/org-identity';
import { OrgBrand } from '@/components/brand/org-brand';
import { SangrahaCoBrand } from '@/components/brand/sangraha-mark';
import { AdminNav } from '@/components/admin/admin-nav';
import { SetupBanner } from '@/components/admin/setup-banner';

/**
 * The admin shell.
 *
 * Deliberately outside the `(field)` group and its theme. This is a desktop tool
 * used daily by one person who knows the product; the field UI is used
 * occasionally, on a phone, by someone who may not. Sharing a layout between
 * them would compromise both — so the admin console uses the default Tailwind
 * scales, denser type and ordinary-sized controls.
 *
 * The navigation lives in `AdminNav`, which needs the current path to show
 * where you are, so it is a client component.
 */

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(['org_admin', 'super_admin']);
  const progress = await withSession(session, (tx) => getSetupProgress(tx, session.orgId));
  const org = await getOrgIdentityById(session.orgId);

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 text-sm text-slate-900">
      <header className="relative flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-6 py-2">
        {org ? (
          <span className="mr-1 border-r border-slate-200 pr-4">
            <OrgBrand org={org} size="sm" />
          </span>
        ) : null}

        <AdminNav />

        {/* Centred on the header, and only where there is genuinely room:
            below `xl` the navigation and the right-hand links already meet in
            the middle, and a mark there would sit on top of them. */}
        <SangrahaCoBrand className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 xl:inline-flex" />

        {/* A way back to capture: an admin is often also the person testing a
            form on their own phone. */}
        <Link
          href="/"
          className="ml-auto inline-flex items-center gap-1.5 text-brand-700 hover:underline"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Field app
        </Link>
        {/* Sign-out lives in the field app's menu, shared with this console,
            rather than being duplicated here with its own confirmation. */}
        <Link
          href="/account"
          className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900"
        >
          <CircleUserRound aria-hidden className="h-4 w-4" />
          {session.fullName}
        </Link>
      </header>

      <SetupBanner progress={progress} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
