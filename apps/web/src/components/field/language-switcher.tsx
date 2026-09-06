'use client';

import { Languages } from 'lucide-react';
import { LANGUAGE_NAMES } from '@/lib/i18n';

/**
 * Language picker.
 *
 * Each language is written in its own script, never transliterated: someone who
 * reads Kannada looks for "ಕನ್ನಡ", not for "Kannada". Present on the login
 * screen and persistently in the field header, because being stuck in a
 * language you cannot read is otherwise unrecoverable.
 */
export function LanguageSwitcher({
  value,
  locales,
  onChange,
}: {
  value: string;
  locales: readonly string[];
  onChange: (locale: string) => void;
}) {
  if (locales.length < 2) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Languages aria-hidden className="h-5 w-5 text-slate-500" />
      {locales.map((locale) => {
        const selected = locale === value;
        return (
          <button
            key={locale}
            type="button"
            onClick={() => onChange(locale)}
            aria-pressed={selected}
            className={
              selected
                ? 'min-h-[2.75rem] rounded-full bg-brand-600 px-4 text-field-sm font-semibold text-white'
                : 'min-h-[2.75rem] rounded-full border-2 border-slate-300 bg-white px-4 text-field-sm font-medium text-slate-700'
            }
          >
            {LANGUAGE_NAMES[locale] ?? locale}
          </button>
        );
      })}
    </div>
  );
}
