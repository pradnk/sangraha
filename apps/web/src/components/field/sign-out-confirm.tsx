'use client';

import { useEffect, useState, useTransition } from 'react';
import { LogOut } from 'lucide-react';
import { m } from '@/lib/messages';
import { getQueue } from '@/lib/submission-queue';
import { signOutAction } from '@/app/(field)/account/actions';

/**
 * Sign out, with the one warning that matters.
 *
 * Two taps rather than one, because a shared phone in a village makes an
 * accidental sign-out expensive: the next worker cannot use it until somebody
 * remembers a PIN. And if anything is still queued on the device, that is said
 * before they commit — otherwise a worker who signs out in a dead zone has no
 * way of knowing their morning's records are still on the phone.
 */
export function SignOutConfirm({ locale }: { locale: string }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [waiting, setWaiting] = useState(0);

  // Read on the client: the queue lives in localStorage, so the server has no
  // idea whether anything is held on this device.
  useEffect(() => {
    if (confirming) setWaiting(getQueue().length);
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="flex min-h-tap w-full items-center gap-3 px-4 text-left text-field-base font-medium text-deny-700 active:bg-deny-50"
      >
        <LogOut aria-hidden className="h-6 w-6 shrink-0" />
        {m(locale, 'signOut')}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 bg-deny-50 p-4">
      <p className="text-field-base font-semibold text-deny-700">
        {m(locale, 'signOutConfirm')}
      </p>

      {/* Only mentioned when it is true. Telling someone nothing will be lost
          when nothing was at risk just introduces a worry. */}
      {waiting > 0 ? (
        <p className="text-field-sm text-deny-700">
          {m(locale, 'waitingToSend', { count: waiting })} — {m(locale, 'signOutWarning')}
        </p>
      ) : null}

      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => signOutAction())}
        className="field-button bg-deny-500 text-white disabled:opacity-60"
      >
        <LogOut aria-hidden className="h-5 w-5" />
        {m(locale, 'signOut')}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="field-button border-2 border-slate-300 bg-white text-slate-800"
      >
        {m(locale, 'stay')}
      </button>
    </div>
  );
}
