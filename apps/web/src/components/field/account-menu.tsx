'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CircleUserRound, Inbox, Search, Settings, UserCog, X } from 'lucide-react';
import { m } from '@/lib/messages';
import { SignOutConfirm } from './sign-out-confirm';

/**
 * Everything that is not filling in a form.
 *
 * These four actions used to sit at the bottom of the home screen, below the
 * form cards — so every form an organisation added pushed "Manage forms"
 * further down, and eventually off the screen. They are navigation, not work,
 * and the work grows; putting them behind the name in the header means the
 * home screen can be about forms and stay that way at three forms or thirty.
 *
 * Opened by the person's own name, which is where people already look for
 * sign-out, and which is a word rather than an icon somebody has to decode.
 */

export interface MenuLink {
  href: string;
  label: string;
  icon: 'search' | 'inbox' | 'settings';
}

const ICONS = {
  search: Search,
  inbox: Inbox,
  settings: Settings,
} as const;

export function AccountMenu({
  fullName,
  links,
  locale,
  alignRight = true,
}: {
  fullName: string;
  links: MenuLink[];
  locale: string;
  /** False when something to its left already claimed the spare space. */
  alignRight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panel = useRef<HTMLDivElement>(null);

  // Navigating away closes it. Without this the menu stays open over the page
  // it just opened, which reads as the tap not having worked.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    // Deferred a tick so the tap that opened the menu does not close it again.
    const timer = setTimeout(() => document.addEventListener('pointerdown', onPointer), 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      clearTimeout(timer);
    };
  }, [open]);

  return (
    <div ref={panel} className={`relative ${alignRight ? 'ml-auto' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-h-tap items-center gap-2 rounded-field px-2 text-field-sm font-medium text-slate-700"
      >
        {open ? (
          <X aria-hidden className="h-6 w-6" />
        ) : (
          <CircleUserRound aria-hidden className="h-6 w-6" />
        )}
        {/* Tighter on a phone so the centred mark has room to be centred.
            The name is still there — it is what people tap for sign-out — just
            shortened before the organisation's own name would have to be. */}
        <span className="max-w-[4.5rem] truncate sm:max-w-[9rem]">{fullName}</span>
        <span className="sr-only">{open ? m(locale, 'closeMenu') : m(locale, 'menu')}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-field border-2 border-slate-200 bg-white shadow-lg"
        >
          {links.map((link) => {
            const Icon = ICONS[link.icon];
            return (
              <Link
                key={link.href}
                href={link.href}
                role="menuitem"
                className="flex min-h-tap items-center gap-3 border-b border-slate-100 px-4 text-field-base text-slate-900 active:bg-brand-50"
              >
                <Icon aria-hidden className="h-6 w-6 shrink-0 text-brand-600" />
                <span className="flex-1">{link.label}</span>
              </Link>
            );
          })}

          {/* Below the actions, as the person's own settings rather than
              another place to go and work. */}
          <Link
            href="/account"
            role="menuitem"
            className="flex min-h-tap items-center gap-3 border-b border-slate-100 px-4 text-field-base text-slate-900 active:bg-brand-50"
          >
            <UserCog aria-hidden className="h-6 w-6 shrink-0 text-slate-500" />
            <span className="flex-1">{m(locale, 'profile')}</span>
          </Link>

          {/*
           * Last, and the only destructive thing here. Still confirmed, and
           * still warns about anything queued on the device — a worker who
           * signs out in a dead zone must not be led to think their morning's
           * records went with them.
           */}
          <SignOutConfirm locale={locale} />
        </div>
      ) : null}
    </div>
  );
}
