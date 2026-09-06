import Link from 'next/link';
import { Rocket } from 'lucide-react';
import type { SetupProgress } from '@sangraha/db';

/**
 * A persistent nudge across the admin console until setup is done.
 *
 * Shows the count rather than a vague "finish setting up", because an
 * administrator who has done four of six steps needs to know which two are
 * left, not that something remains.
 */
export function SetupBanner({ progress }: { progress: SetupProgress }) {
  const required = [
    progress.hasPlaces,
    progress.hasPurposes,
    progress.hasForm,
    progress.hasPublishedForm,
    progress.hasPublishedNotice,
    progress.hasPrivacyContact,
    progress.hasTeam,
    progress.hasSubmission,
  ];
  const remaining = required.filter((done) => !done).length;

  if (remaining === 0 || progress.dismissed) return null;

  return (
    <Link
      href="/admin/setup"
      className="flex items-center gap-3 border-b border-brand-200 bg-brand-50 px-6 py-2.5 text-brand-900 hover:bg-brand-100"
    >
      <Rocket aria-hidden className="h-4 w-4 shrink-0" />
      <span>
        <span className="font-medium">Getting started</span> — {remaining}{' '}
        {remaining === 1 ? 'step' : 'steps'} left to have your team collecting data.
      </span>
      <span className="ml-auto shrink-0 font-medium">Continue →</span>
    </Link>
  );
}
