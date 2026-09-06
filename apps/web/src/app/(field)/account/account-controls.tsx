'use client';

import { useTransition } from 'react';
import { LanguageSwitcher } from '@/components/field/language-switcher';
import { UI_LOCALES } from '@/lib/i18n';
import { m } from '@/lib/messages';
import { setLocaleAction } from './actions';

/**
 * The settings that belong to the person rather than to the work.
 *
 * Sign-out used to live here too, and has moved into the header menu — that is
 * where people look for it, and it kept this screen from being a detour on the
 * way to leaving. Changing a PIN stays: it is a deliberate act nobody performs
 * by accident, and burying it behind a menu would make it harder to talk
 * somebody through over the phone.
 */
export function AccountControls({ locale }: { locale: string }) {
  const [, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-field-sm text-slate-500">{m(locale, 'language')}</p>
      <LanguageSwitcher
        value={locale}
        locales={UI_LOCALES}
        onChange={(next) => startTransition(() => setLocaleAction(next))}
      />
    </div>
  );
}
