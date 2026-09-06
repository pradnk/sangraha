'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, UserX } from 'lucide-react';
import { requestErasureAction } from '@/app/admin/privacy/erasure-actions';

/**
 * Filing a request to be forgotten, from the record it is about.
 *
 * Here rather than on a compliance screen because this is where somebody is
 * standing when the request arrives — a worker relays it, an admin opens the
 * record, and the button is in front of them. A rights process that lives three
 * clicks away in a settings menu is one that gets handled by email instead.
 *
 * Two deliberate frictions, and no more. The person's name has to be typed,
 * because this hides a real record from everyone the moment it is pressed; and
 * how they were identified has to be written down, because "somebody phoned and
 * said they were Sunita" is exactly the request that should not be honoured
 * without a note explaining why it was.
 */
export function ForgetPerson({
  subjectId,
  displayName,
}: {
  subjectId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [identity, setIdentity] = useState('');
  const [mode, setMode] = useState<'pseudonymise' | 'hard_delete'>('pseudonymise');

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 self-start rounded-lg border border-deny-300 px-3 py-1.5 text-sm text-deny-700 hover:bg-deny-50"
      >
        <UserX aria-hidden className="h-4 w-4" />
        Forget this person
      </button>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-deny-300 bg-deny-50 p-4">
      <div>
        <h2 className="font-semibold text-deny-800">Forget {displayName}</h2>
        <p className="mt-1 text-sm text-deny-700">
          They will be hidden from everyone immediately — searches, reports, spreadsheets. Nothing
          is permanently removed until you run the erasure from the Privacy screen, so a mistake
          here can be undone until then.
        </p>
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-deny-800">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">What should happen to their records?</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            checked={mode === 'pseudonymise'}
            onChange={() => setMode('pseudonymise')}
            className="mt-1"
          />
          <span>
            Remove their name and details, keep the anonymous rows
            <span className="block text-xs text-deny-700">
              {/* Said honestly. Village plus age plus caste is near-unique at
                  this scale, so the result is still personal data. */}
              Your totals stay the same. Be aware this is not the same as truly anonymous — someone
              determined could still work out who a row is from where and when.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            checked={mode === 'hard_delete'}
            onChange={() => setMode('hard_delete')}
            className="mt-1"
          />
          <span>
            Delete the records entirely
            <span className="block text-xs text-deny-700">
              The cleanest answer to give them. Your monthly totals are kept separately, so reports
              still add up, but the individual records are gone.
            </span>
          </span>
        </label>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        How do you know it is really them?
        <input
          value={identity}
          onChange={(event) => setIdentity(event.target.value)}
          placeholder="Came to the centre in person; known to Sunita for two years"
          className="rounded border border-deny-300 px-3 py-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Type <strong>{displayName}</strong> to confirm
        <input
          value={confirmName}
          onChange={(event) => setConfirmName(event.target.value)}
          className="rounded border border-deny-300 px-3 py-2"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending || confirmName.trim() !== displayName || identity.trim().length < 5}
          onClick={() =>
            startTransition(async () => {
              const result = await requestErasureAction({
                subjectId,
                mode,
                identityCheckedNote: identity,
              });
              setError(result.error ?? null);
              if (!result.error) setOpen(false);
              router.refresh();
            })
          }
          className="rounded bg-deny-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Hide them now
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
