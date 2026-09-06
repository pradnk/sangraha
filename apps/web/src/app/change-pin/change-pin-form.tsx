'use client';

import { useActionState } from 'react';
import { AlertCircle } from 'lucide-react';
import { m } from '@/lib/messages';
import { submitNewPin, type ChangePinState } from './actions';

export function ChangePinForm({ locale }: { locale: string }) {
  const [state, formAction, pending] = useActionState<ChangePinState, FormData>(submitNewPin, {});

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-3 rounded-field bg-deny-50 p-4 text-field-sm font-medium text-deny-700"
        >
          <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <PinField name="currentPin" label={m(locale, 'currentPin')} autoComplete="current-password" />
      <PinField name="newPin" label={m(locale, 'newPin')} autoComplete="new-password" />
      <PinField name="confirmPin" label={m(locale, 'confirmPin')} autoComplete="new-password" />

      <button
        type="submit"
        disabled={pending}
        className="field-button mt-2 bg-brand-600 text-white disabled:opacity-60"
      >
        {pending ? m(locale, 'saving') : m(locale, 'save')}
      </button>
    </form>
  );
}

function PinField({
  name,
  label,
  autoComplete,
}: {
  name: string;
  label: string;
  autoComplete: string;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-field-base font-semibold text-slate-800">{label}</span>
      <input
        name={name}
        type="password"
        required
        inputMode="numeric"
        pattern="[0-9]*"
        minLength={6}
        maxLength={12}
        autoComplete={autoComplete}
        // Password managers rewrite this input's attributes between the server
        // HTML and hydration, which React reports as a mismatch it cannot
        // patch up — see the longer note in `app/start/start-form.tsx`.
        suppressHydrationWarning
        className="field-control py-3 tracking-[0.4em]"
      />
    </label>
  );
}
