import Link from 'next/link';
import { signupAvailability } from '@/lib/signup';
import { SangrahaLogo } from '@/components/brand/sangraha-mark';
import { StartForm } from './start-form';

/*
 * Never prerendered.
 *
 * This page asks the database a question whose answer changes the moment the
 * page is used: does an organisation exist yet? Every other page is dynamic by
 * accident — it reads `cookies()` for the session, or awaits `searchParams` —
 * but this one needs neither, so Next statically prerenders it at build time
 * and freezes the answer into HTML.
 *
 * Two ways that hurt. The build acquires a database dependency it should not
 * have: no Postgres reachable means `ECONNREFUSED` and a failed build, which is
 * what a preview deployment without `DATABASE_URL` looks like. And on a real
 * deployment the bootstrap door appears not to shut — the first administrator
 * signs up, and `/start` goes on serving the cached "Set up your organisation"
 * form to everyone after them. The signup action re-checks availability, so
 * nobody actually gets in; they just get an invitation the system then refuses.
 */
export const dynamic = 'force-dynamic';

/**
 * Creating an organisation.
 *
 * Four questions and no more. Everything else an organisation needs — places,
 * languages, forms, staff — is easier to decide once you can see the product,
 * so it belongs in the setup guide rather than in a wall of fields before you
 * have seen anything.
 */
export default async function StartPage() {
  const availability = await signupAvailability();

  if (!availability.allowed) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5">
        <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center">
          <h1 className="mb-2 text-xl font-bold">Not accepting new organisations</h1>
          <p className="text-slate-600">
            This installation already has an organisation. Ask its administrator to add you, and
            they will give you a sign-in name and a PIN.
          </p>
          <Link href="/login" className="mt-4 inline-block text-brand-700 hover:underline">
            Sign in instead
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col bg-slate-50">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 py-10">
        {/* The only screen where our own mark leads: there is no organisation
            yet to put in its place. */}
        <SangrahaLogo size="md" showTagline className="mb-8" />

        <h1 className="text-2xl font-bold text-slate-900">Set up your organisation</h1>
        <p className="mt-2 text-slate-600">
          Takes about a minute. You will be its first administrator, and we will walk you through
          what comes next.
        </p>

        {/* Said plainly, because it is the one chance to say it: on a fresh
            deployment this page is open precisely until it is used. */}
        {availability.bootstrap ? (
          <p className="mt-4 rounded-lg bg-brand-50 p-3 text-sm text-brand-900">
            This is a new installation, so this page is open. Once you create your organisation it
            closes, and only you will be able to add people.
          </p>
        ) : null}

        <StartForm requiresCode={availability.requiresCode} />

        <p className="mt-6 text-center text-slate-600">
          Already have an account?{' '}
          <Link href="/login" className="text-brand-700 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
