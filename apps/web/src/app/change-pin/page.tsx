import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth/session';
import { m } from '@/lib/messages';
import { ChangePinForm } from './change-pin-form';

/**
 * Forced when a supervisor has issued a temporary PIN, so a supervisor never
 * durably knows a colleague's credentials.
 */
export default async function ChangePinPage() {
  const session = await readSession();
  if (!session) redirect('/login');

  return (
    <main className="theme-field flex min-h-dvh flex-col bg-slate-50">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-8">
        <h1 className="mb-6 text-center text-2xl font-bold text-slate-900">
          {m(session.locale, 'chooseNewPin')}
        </h1>
        <ChangePinForm locale={session.locale} />
      </div>
    </main>
  );
}
