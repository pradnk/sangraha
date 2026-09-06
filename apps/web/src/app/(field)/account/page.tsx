import Link from 'next/link';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { eq } from 'drizzle-orm';
import { locations, userLocations } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';
import { AccountControls } from './account-controls';

const ROLE_LABELS: Record<string, string> = {
  field_worker: 'Field worker',
  supervisor: 'Supervisor',
  org_admin: 'Administrator',
  super_admin: 'Platform administrator',
};

/**
 * The account screen.
 *
 * Exists because sign-out had nowhere to live. Grouping it with the language
 * switcher and PIN change also fixes a real trap: language was previously only
 * selectable at login, so a worker who picked one they could not read had no
 * visible way back.
 */
export default async function AccountPage() {
  const session = await requireSession();

  const places = await withSession(session, (tx) =>
    tx
      .select({ name: locations.name })
      .from(userLocations)
      .innerJoin(locations, eq(locations.id, userLocations.locationId))
      .where(eq(userLocations.userId, session.userId)),
  );

  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      <Link
        href="/"
        className="inline-flex min-h-tap items-center gap-2 self-start text-field-base font-medium text-brand-700"
      >
        <ArrowLeft aria-hidden className="h-5 w-5" />
        {m(session.locale, 'home')}
      </Link>

      <h1 className="text-field-lg font-bold text-slate-900">
        {m(session.locale, 'yourAccount')}
      </h1>

      <dl className="flex flex-col gap-3 rounded-field bg-slate-50 p-4">
        <div>
          <dt className="text-field-sm text-slate-500">{m(session.locale, 'signedInAs')}</dt>
          <dd className="text-field-base font-semibold text-slate-900">{session.fullName}</dd>
        </div>
        <div>
          <dt className="text-field-sm text-slate-500">{ROLE_LABELS[session.role] ?? session.role}</dt>
          {places.length > 0 ? (
            <dd className="text-field-base text-slate-700">
              {places.map((place) => t(place.name, session.locale)).join(', ')}
            </dd>
          ) : null}
        </div>
      </dl>

      <AccountControls locale={session.locale} />

      <Link
        href="/change-pin"
        className="field-button border-2 border-slate-300 bg-white text-slate-800"
      >
        <KeyRound aria-hidden className="h-5 w-5" />
        {m(session.locale, 'changeYourPin')}
      </Link>
    </div>
  );
}
