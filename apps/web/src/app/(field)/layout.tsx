import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { countAwaitingReview, forms } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { getOrgIdentityById } from '@/lib/org-identity';
import { OrgBrand } from '@/components/brand/org-brand';
import { SangrahaCoBrand } from '@/components/brand/sangraha-mark';
import { AccountMenu, type MenuLink } from '@/components/field/account-menu';
import { ReviewBell } from '@/components/field/review-bell';
import { QueueIndicator } from '@/components/field/queue-indicator';
import { m } from '@/lib/messages';

/**
 * The field shell.
 *
 * The organisation's own mark on the left doubles as the home link, the send
 * queue sits in the middle when it has something to say, and everything that is
 * not filling in a form lives behind the person's name on the right.
 *
 * Leading with the NGO's identity rather than ours is the point: a worker
 * should feel they are using their organisation's system.
 *
 * The menu is opened by the person's name — a word rather than an icon somebody
 * has to decode, and where people already look for sign-out. Its contents used
 * to be cards at the bottom of the home screen, which meant every form an
 * organisation added pushed "Manage forms" further down and eventually off the
 * screen. Navigation does not grow; the work does.
 *
 * How many records are waiting to be approved sits outside the menu, on a bell,
 * because that number is what a supervisor opens the app to find out.
 */
export default async function FieldLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const org = await getOrgIdentityById(session.orgId);

  const canReview = session.role === 'supervisor' || session.role === 'org_admin';
  const isAdmin = session.role === 'org_admin' || session.role === 'super_admin';

  const { awaitingReview, hasRegistry } = await withSession(session, async (tx) => ({
    awaitingReview: canReview ? await countAwaitingReview(tx) : 0,
    // "Find a person" is only worth offering once there is a registry to
    // search — an organisation running one-off surveys has nobody in it.
    hasRegistry:
      (
        await tx
          .select({ id: forms.id })
          .from(forms)
          .where(
            and(
              eq(forms.orgId, session.orgId),
              eq(forms.formType, 'registration'),
              eq(forms.isActive, true),
            ),
          )
          .limit(1)
      ).length > 0,
  }));

  const links: MenuLink[] = [];
  if (hasRegistry) {
    links.push({ href: '/find', label: m(session.locale, 'findPerson'), icon: 'search' });
  }
  links.push({
    href: '/my-submissions',
    label: m(session.locale, 'mySubmissions'),
    icon: 'inbox',
  });
  if (isAdmin) {
    links.push({ href: '/admin/forms', label: m(session.locale, 'manageForms'), icon: 'settings' });
  }

  return (
    <div className="theme-field flex min-h-dvh flex-col bg-white">
      <header className="relative flex items-center gap-3 border-b border-slate-200 px-3 py-2">
        <Link href="/" aria-label="Home" className="flex min-h-tap items-center pr-1">
          {org ? (
            <OrgBrand org={org} size="md" className="max-w-[8rem] truncate sm:max-w-[11rem]" />
          ) : (
            <span className="font-semibold">Home</span>
          )}
        </Link>

        {/* Absolutely centred so it is the middle of the *header*, not the
            middle of whatever space the other items happen to leave. Behind
            them in the stacking order and non-interactive, so it can never
            take a tap meant for the bell or the menu. */}
        <SangrahaCoBrand className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />

        <QueueIndicator locale={session.locale} />

        {/* Left of the name, and outside the menu: the count is the whole
            reason a supervisor opens the queue, so having to open a menu to
            see it defeated the purpose. */}
        {canReview ? (
          <div className="ml-auto">
            <ReviewBell count={awaitingReview} locale={session.locale} />
          </div>
        ) : null}

        <AccountMenu
          fullName={session.fullName}
          links={links}
          locale={session.locale}
          alignRight={!canReview}
        />
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
