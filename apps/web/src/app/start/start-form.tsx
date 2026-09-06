'use client';

import { useActionState } from 'react';
import { AlertCircle, ArrowRight } from 'lucide-react';
import { startAction, type StartState } from './actions';

export function StartForm({ requiresCode }: { requiresCode: boolean }) {
  const [state, formAction, pending] = useActionState<StartState, FormData>(startAction, {});

  /*
   * React clears an uncontrolled form as soon as its action returns, so a
   * rejected PIN used to wipe the organisation name, their name and their
   * sign-in name too. The server sends back what they typed and it goes
   * straight back in — except the PINs, which never leave the server and are
   * worth retyping after a rejection anyway.
   *
   * `key` is what makes it stick: without it React reuses the same input
   * elements and ignores the changed `defaultValue`.
   */
  const kept = state.values;

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-5 rounded-lg border border-slate-200 bg-white p-6">
      {state.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {state.error}
        </p>
      ) : null}

      {requiresCode ? (
        <Field
          key={`code-${kept?.code ?? ''}`}
          name="code"
          label="Invitation code"
          hint="Given to you by whoever runs this installation."
          defaultValue={kept?.code}
          invalid={state.field === 'code'}
          required
        />
      ) : null}

      <Field
        key={`name-${kept?.name ?? ''}`}
        name="name"
        label="What is your organisation called?"
        placeholder="Shiksha Foundation"
        hint="Shown on the sign-in screen. You can change it later."
        defaultValue={kept?.name}
        invalid={state.field === 'name'}
        required
        autoFocus
      />

      <Field
        key={`fullName-${kept?.fullName ?? ''}`}
        name="fullName"
        label="Your name"
        placeholder="Meera Joshi"
        defaultValue={kept?.fullName}
        invalid={state.field === 'fullName'}
        required
      />

      <Field
        key={`username-${kept?.username ?? ''}`}
        name="username"
        label="Choose your sign-in name"
        placeholder="meera"
        hint="Letters, numbers and underscores. Short is better — your team will type theirs on a phone."
        pattern="[A-Za-z0-9_]+"
        autoComplete="username"
        defaultValue={kept?.username}
        invalid={state.field === 'username'}
        required
      />

      {/*
       * `autoComplete` on both, matching `/login` and `/change-pin`.
       *
       * Not cosmetic. A password manager faced with two unlabelled
       * `type="password"` fields on what looks like a signup form guesses what
       * they are and rewrites them — adding attributes, sometimes filling them
       * — which arrives after the server HTML and shows up as a React
       * hydration mismatch. Saying `new-password` tells it exactly what these
       * are, so it stops guessing. It is also simply the correct value here:
       * this is a PIN being chosen, not one being recalled.
       *
       * `suppressHydrationWarning` is the belt to that braces. Some managers
       * rewrite `autocomplete` regardless of what we asked for, and the
       * resulting warning is unactionable — the attribute belongs to software
       * we do not control, and React cannot patch it up. Suppression here is
       * exactly one level deep: it covers these two inputs' own attributes and
       * nothing else on the page, so a genuine mismatch anywhere else still
       * surfaces.
       */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          name="pin"
          label="Choose a PIN"
          type="password"
          hint="6 to 12 numbers."
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="new-password"
          minLength={6}
          maxLength={12}
          invalid={state.field === 'pin'}
          suppressHydrationWarning
          required
        />
        <Field
          name="confirmPin"
          label="Type it again"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="new-password"
          minLength={6}
          maxLength={12}
          invalid={state.field === 'confirmPin'}
          suppressHydrationWarning
          required
        />
      </div>

      {/* Said plainly rather than buried in a policy: there is no email on file,
          so a forgotten PIN means another administrator resets it. */}
      <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        There are no email addresses or passwords here — your team signs in with a name and a PIN,
        which works on a shared phone with no network to receive a code. Keep your PIN safe: if you
        lose it, another administrator has to reset it for you.
      </p>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {pending ? 'Setting up…' : 'Create my organisation'}
        <ArrowRight aria-hidden className="h-4 w-4" />
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  invalid,
  ...input
}: {
  name: string;
  label: string;
  hint?: string;
  invalid?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-medium">{label}</span>
      <input
        name={name}
        aria-invalid={invalid || undefined}
        className={`rounded border px-3 py-2 ${invalid ? 'border-deny-500' : 'border-slate-300'}`}
        {...input}
      />
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}
