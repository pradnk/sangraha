'use client';

import { useActionState, useEffect, useState } from 'react';
import { AlertCircle, LogIn } from 'lucide-react';
import { LanguageSwitcher } from '@/components/field/language-switcher';
import { UI_LOCALES } from '@/lib/i18n';
import { m } from '@/lib/messages';
import type { SignInOrganisation } from '@/lib/auth/organisations';
import { OrgBrand, type OrgIdentity } from '@/components/brand/org-brand';
import { signIn, type LoginState } from './actions';

const LOCALE_STORAGE_KEY = 'mis.locale';
const ORG_STORAGE_KEY = 'mis.orgSlug';

export function LoginForm({
  organisations,
  defaultOrgSlug,
  expired,
  identity,
}: {
  organisations: SignInOrganisation[];
  defaultOrgSlug: string;
  expired: boolean;
  /** Present when the organisation is known — their logo leads the screen. */
  identity: OrgIdentity | null;
}) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(signIn, {});
  const [locale, setLocale] = useState<string>('en');

  // Resolved rather than typed. With one organisation there is nothing to
  // choose; with several the worker picks a name they recognise. Nobody is
  // asked to recall a slug.
  const single = organisations.length === 1 ? organisations[0] : undefined;
  const [orgSlug, setOrgSlug] = useState(
    defaultOrgSlug || single?.slug || organisations[0]?.slug || '',
  );

  useEffect(() => {
    const savedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (savedLocale) setLocale(savedLocale);

    if (defaultOrgSlug) return;
    const savedOrg = window.localStorage.getItem(ORG_STORAGE_KEY);
    // Only restore a remembered organisation that still exists, or the field
    // silently submits a slug the server will reject.
    if (savedOrg && organisations.some((org) => org.slug === savedOrg)) setOrgSlug(savedOrg);
  }, [defaultOrgSlug, organisations]);

  useEffect(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  useEffect(() => {
    if (orgSlug) window.localStorage.setItem(ORG_STORAGE_KEY, orgSlug);
  }, [orgSlug]);

  if (organisations.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-8">
        <p className="rounded-field bg-amber-50 p-5 text-field-base text-amber-900">
          No organisation has been set up yet. Run <code>npm run db:seed</code> to create the
          demo organisation.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-8">
      <div className="mb-8 flex justify-center">
        <LanguageSwitcher value={locale} locales={UI_LOCALES} onChange={setLocale} />
      </div>

      {/* The organisation leads, not the product. Someone signing in should see
          who they work for, not who wrote the software. */}
      {identity ? (
        <div className="mb-6 flex justify-center">
          <OrgBrand org={identity} size="lg" />
        </div>
      ) : null}

      <h1 className="mb-6 text-center text-2xl font-bold text-slate-900">{m(locale, 'signIn')}</h1>

      {expired && !state.error ? (
        <p className="mb-4 rounded-field bg-amber-50 p-4 text-field-sm text-amber-900">
          {m(locale, 'sessionExpired')}
        </p>
      ) : null}

      {state.error ? (
        <p
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-field bg-deny-50 p-4 text-field-sm font-medium text-deny-700"
        >
          <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="locale" value={locale} />

        {single ? (
          // One organisation: carried silently. Showing a field with a single
          // fixed value is a question with one answer.
          <input type="hidden" name="orgSlug" value={single.slug} />
        ) : (
          <label className="flex flex-col gap-2">
            <span className="text-field-base font-semibold text-slate-800">
              {m(locale, 'organisation')}
            </span>
            <select
              name="orgSlug"
              value={orgSlug}
              onChange={(event) => setOrgSlug(event.target.value)}
              className="field-control py-3"
            >
              {organisations.map((org) => (
                <option key={org.slug} value={org.slug}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-2">
          <span className="text-field-base font-semibold text-slate-800">
            {m(locale, 'username')}
          </span>
          <input
            name="username"
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={state.field === 'username' || undefined}
            className="field-control py-3"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-field-base font-semibold text-slate-800">{m(locale, 'pin')}</span>
          <span className="text-field-sm text-slate-500">{m(locale, 'pinHint')}</span>
          <input
            name="pin"
            type="password"
            required
            // `inputMode` and `pattern` together summon the numeric keypad on
            // Android and iOS. Typing a PIN on a full QWERTY keyboard is a
            // needless source of mistakes.
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="current-password"
            maxLength={12}
            aria-invalid={state.field === 'pin' || undefined}
            // Password managers rewrite this input's attributes between the
            // server HTML and hydration, which React reports as a mismatch it
            // cannot patch up. The attribute is theirs, not ours, so the
            // warning is unactionable — see the longer note in
            // `app/start/start-form.tsx`.
            suppressHydrationWarning
            className="field-control py-3 tracking-[0.4em]"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="field-button mt-2 bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60"
        >
          <LogIn aria-hidden className="h-5 w-5" />
          {pending ? m(locale, 'signingIn') : m(locale, 'signIn')}
        </button>
      </form>
    </div>
  );
}
