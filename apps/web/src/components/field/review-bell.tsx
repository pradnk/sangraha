import Link from 'next/link';
import { Bell } from 'lucide-react';
import { m } from '@/lib/messages';

/**
 * How many records are waiting to be approved.
 *
 * A count is the only thing a supervisor needs to decide whether to open the
 * queue at all, and burying it in a menu meant they had to open the menu to
 * find out. In the header it answers the question without a tap.
 *
 * The one place in the field UI where an icon stands without a word beside it.
 * The rule elsewhere — icon *and* text, never icon alone — exists because an
 * untrained worker cannot decode a glyph; this is shown only to supervisors and
 * admins, a bell with a number on it is about as widely understood as an
 * interface convention gets, and it still carries a full label for anyone
 * using a screen reader.
 */
export function ReviewBell({ count, locale }: { count: number; locale: string }) {
  const label = count > 0 ? `${m(locale, 'reviewQueue')} (${count})` : m(locale, 'reviewQueue');

  return (
    <Link
      href="/review"
      aria-label={label}
      title={label}
      className="flex min-h-tap min-w-tap items-center justify-center rounded-field text-slate-700"
    >
      {/* The badge hangs off the corner of the icon rather than sitting inside
          the tap target, which is what had it covering the bell entirely. */}
      <span className="relative inline-flex">
        <Bell aria-hidden className="h-7 w-7" />

        {count > 0 ? (
          <span
            aria-hidden
            className="absolute -right-2.5 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-deny-500 px-1 text-[0.7rem] font-bold leading-none text-white"
          >
            {/* Past a point the exact number stops mattering, and the width
                starts pushing the person's name off a small screen. */}
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
