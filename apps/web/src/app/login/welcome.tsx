import Link from 'next/link';
import { ArrowRight, ClipboardList, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { SangrahaLogo } from '@/components/brand/sangraha-mark';

/**
 * The first screen of an installation with nothing in it yet.
 *
 * Reached when the database holds no organisation, which happens exactly once
 * per deployment: the operator has just finished wiring up a database and has
 * arrived at a sign-in page with nobody to sign in as. It used to be an amber
 * warning box floating in an empty viewport — accurate, after a fix, and still
 * reading as a fault rather than an invitation.
 *
 * So it says what the product is, and offers the one action available. Both
 * halves matter: whoever sees this may be evaluating Sangraha rather than
 * deploying it, and a bare "no organisation" tells them nothing about whether
 * to continue.
 *
 * This is the one place the full mark belongs. Inside a live organisation the
 * header carries *their* logo and Sangraha co-brands quietly beside it — see
 * `SangrahaCoBrand`. Here there is no organisation to lead, so there is nothing
 * to be louder than.
 *
 * Deliberately not `theme-field`. The field scale exists for a worker reading
 * slowly on a phone outdoors; this is read once, by an administrator, on
 * whatever they deployed from — so it uses the admin scale, and matches
 * `/start`, which is where the button goes.
 *
 * English only. There is no language switcher on it and no organisation whose
 * languages could inform one; the strings do not belong in `messages.ts`, which
 * is for the field UI.
 */

/**
 * What the product actually does, in four lines.
 *
 * Every claim here is one the README stands behind under **What it does** and
 * **Status**. Nothing aspirational: a landing page that promises a feature the
 * product does not have is a bug report waiting to be filed. In particular the
 * offline line says *send queue* rather than *works offline* — the retry queue
 * is built, the full offline PWA is not.
 */
const CAPABILITIES = [
  {
    icon: ClipboardList,
    title: 'Forms you define yourself',
    detail:
      'Questions, answer lists, validation and skip logic. Publish when ready; a published version is never edited, so old answers stay readable.',
  },
  {
    icon: Smartphone,
    title: 'Answered on a phone',
    detail:
      'One question per screen, in English, Hindi or Kannada. A send queue holds what was captured until the link comes back.',
  },
  {
    icon: Users,
    title: 'A registry, not a pile of forms',
    detail:
      'People are registered once and visits are captured against them over time, so a record has a history rather than a date.',
  },
  {
    icon: ShieldCheck,
    title: 'Isolation the database enforces',
    detail:
      'Row-Level Security decides what each role can read — a worker only their own submissions. The screen is not the boundary.',
  },
] as const;

export function Welcome() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-5 py-12">
      <div className="w-full max-w-2xl">
        {/* No tagline: it reads "Data collection for the social sector"
            directly above a headline that opens the same way. The headline is
            the more specific of the two, so it keeps the line. */}
        <SangrahaLogo size="lg" />

        <h1 className="mt-8 text-balance text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Data collection an organisation defines for itself.
        </h1>

        <p className="mt-4 max-w-xl text-slate-600">
          Nothing has been set up here yet. Whoever creates the first organisation becomes its
          administrator, and signup closes behind them — everyone after that is added from inside.
        </p>

        <Link
          href="/start"
          className="mt-7 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-3 font-medium text-white hover:bg-brand-700"
        >
          Set up your organisation
          <ArrowRight size={18} aria-hidden />
        </Link>

        <div className="mt-12 grid gap-x-8 gap-y-7 border-t border-slate-200 pt-10 sm:grid-cols-2">
          {CAPABILITIES.map(({ icon: Icon, title, detail }) => (
            <div key={title}>
              <h2 className="flex items-center gap-2.5 font-medium text-slate-900">
                {/* The accent carries the meaning here, so the icon is the
                    product's own colour rather than another grey. */}
                <Icon size={18} className="shrink-0 text-brand-600" aria-hidden />
                {title}
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{detail}</p>
            </div>
          ))}
        </div>

        {/* slate-600, not slate-500. The smaller size and the position below a
            rule are what make this line quiet; slate-500 here measures 4.55:1
            on slate-50, which passes only just, and the co-brand already taught
            this project that reaching for a lighter grey is the wrong lever. */}
        <p className="mt-10 border-t border-slate-200 pt-6 text-sm text-slate-600">
          Built for India&rsquo;s DPDP Act: stated purposes, generated privacy notices, an
          append-only consent log, an access log and erasure.
        </p>
      </div>
    </main>
  );
}
