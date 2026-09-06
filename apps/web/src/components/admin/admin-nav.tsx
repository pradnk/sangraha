'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2,
  ChevronDown,
  FileStack,
  ListTree,
  MapPin,
  Rocket,
  ScrollText,
  ShieldCheck,
  Settings,
  Table2,
  Upload,
  Users,
  Users2,
  type LucideIcon,
} from 'lucide-react';

/**
 * The admin console's navigation.
 *
 * Eight links used to sit in one flat row, all the same weight, with no
 * indication of which one you were on. Two problems in one: nothing to steer
 * by, and a wall of equally loud words to read every time.
 *
 * Split by how often an administrator actually needs them. Forms, Records and
 * People are the daily work and stay in the bar. The other four are set up
 * once and then left alone for months, so they sit behind **Setup** — still one
 * click away, no longer competing for attention with the things that are used
 * every day.
 *
 * Nothing was removed. The current section is now underlined, which the flat
 * row never showed at all.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  hint?: string;
}

/** Used every day. */
const PRIMARY: NavItem[] = [
  { href: '/admin/forms', label: 'Forms', icon: FileStack },
  { href: '/admin/records', label: 'Records', icon: Table2 },
  { href: '/admin/users', label: 'People', icon: Users },
];

/** Set up once, then rarely touched. */
const SETUP: NavItem[] = [
  /*
   * First, because it is the index of everything below it. An administrator who
   * knows they need to change *something* about how the organisation is
   * configured, but not which of these seven screens holds it, should land on
   * the one page that lists all of them with their current state.
   */
  {
    href: '/admin/setup',
    label: 'What you have set up',
    icon: Rocket,
    hint: 'Everything configured so far, and anything still missing',
  },
  {
    href: '/admin/subject-types',
    label: 'Who you register',
    icon: Users2,
    hint: 'Students, households, self-help groups',
  },
  {
    href: '/admin/lists',
    label: 'Answer lists',
    icon: ListTree,
    hint: 'The choices a question offers',
  },
  { href: '/admin/places', label: 'Places', icon: MapPin, hint: 'Districts, blocks, villages' },
  {
    href: '/admin/settings',
    label: 'Organisation',
    icon: Building2,
    hint: 'Name, logo, languages, privacy contact',
  },
  {
    href: '/admin/privacy',
    label: 'Privacy',
    icon: ShieldCheck,
    hint: 'Why you collect things, and what you tell people',
  },
  {
    href: '/admin/access',
    label: 'Who looked at what',
    icon: ScrollText,
    hint: 'A record of who opened or downloaded people’s information',
  },
  {
    href: '/admin/import',
    label: 'Bring in a spreadsheet',
    icon: Upload,
    hint: 'Move your records off Excel or Google Sheets',
  },
];

/** True for the section itself and anything beneath it. */
const isCurrent = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

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
    const timer = setTimeout(() => document.addEventListener('pointerdown', onPointer), 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      clearTimeout(timer);
    };
  }, [open]);

  const inSetup = SETUP.some((item) => isCurrent(pathname, item.href));

  return (
    <nav className="flex items-center gap-1">
      {PRIMARY.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
          className={`inline-flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 font-medium ${
            isCurrent(pathname, item.href)
              ? 'border-brand-600 text-brand-700'
              : 'border-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <item.icon aria-hidden className="h-4 w-4" />
          {item.label}
        </Link>
      ))}

      <div ref={panel} className="relative">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={`inline-flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 font-medium ${
            inSetup
              ? 'border-brand-600 text-brand-700'
              : 'border-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Settings aria-hidden className="h-4 w-4" />
          Setup
          <ChevronDown aria-hidden className={`h-3.5 w-3.5 ${open ? 'rotate-180' : ''}`} />
        </button>

        {open ? (
          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-1 w-[22rem] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg"
          >
            {SETUP.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                aria-current={isCurrent(pathname, item.href) ? 'page' : undefined}
                className={`flex items-start gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50 ${
                  isCurrent(pathname, item.href) ? 'bg-brand-50' : ''
                }`}
              >
                <item.icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                <span className="min-w-0">
                  <span className="block font-medium text-slate-900">{item.label}</span>
                  {/* Room here that the bar never had. "Answer lists" and "Who
                      you register" are this product's own words for things, and
                      a line of explanation is worth more than a shorter menu. */}
                  {item.hint ? (
                    <span className="block text-xs text-slate-500">{item.hint}</span>
                  ) : null}
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
