'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { dismissSetupAction } from './actions';

export function DismissSetup() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await dismissSetupAction();
          router.refresh();
        })
      }
      className="self-start rounded-lg border border-slate-300 bg-white px-4 py-2 hover:bg-slate-50 disabled:opacity-50"
    >
      Hide the getting-started banner
    </button>
  );
}
