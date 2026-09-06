'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, KeyRound, Lock, Plus, UserCheck, UserX } from 'lucide-react';
import type { AdminUserSummary } from '@sangraha/db';
import type { I18nText } from '@sangraha/form-engine';
import { localise } from '@sangraha/form-engine';
import {
  createUserAction,
  resetPinAction,
  setUserActiveAction,
  setUserLocationsAction,
  unlockUserAction,
  updateUserAction,
  type UsersState,
} from './actions';

const ROLE_LABELS: Record<string, string> = {
  field_worker: 'Field worker',
  supervisor: 'Supervisor',
  org_admin: 'Administrator',
  super_admin: 'Platform administrator',
};

const ROLE_HINTS: Record<string, string> = {
  field_worker: 'Captures data. Sees only their own records.',
  supervisor: 'Also reviews records in their assigned places.',
  org_admin: 'Also builds forms and manages people.',
};

export interface PlaceOption {
  id: string;
  name: I18nText;
  level: number;
}

export function UsersManager({
  people,
  places,
  currentUserId,
  locale,
}: {
  people: AdminUserSummary[];
  places: PlaceOption[];
  currentUserId: string;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<UsersState>({});
  const [adding, setAdding] = useState(false);

  const run = (action: () => Promise<UsersState>) =>
    startTransition(async () => {
      setMessage(await action());
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">People</h1>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
        >
          <Plus aria-hidden className="h-4 w-4" />
          Add someone
        </button>
      </div>

      {message.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}

      {/* Shown once. There is no way to retrieve it later — it is stored only as
          a hash — so the copy has to make clear this is the moment to write it
          down or read it out. */}
      {message.issuedPin ? (
        <div className="rounded-lg border-2 border-affirm-500 bg-affirm-50 p-4">
          <p className="font-semibold text-affirm-700">
            PIN for {message.issuedPin.username}
          </p>
          <p className="my-2 font-mono text-3xl tracking-[0.3em] text-affirm-700">
            {message.issuedPin.pin}
          </p>
          <p className="text-affirm-700">
            Give this to them now — it cannot be shown again. They will be asked to choose their
            own PIN when they first sign in.
          </p>
        </div>
      ) : null}

      {adding ? (
        <AddPersonForm places={places} locale={locale} onDone={() => setAdding(false)} onResult={setMessage} />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Person</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Places</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {people.map((person) => (
              <tr key={person.id} className={person.isActive ? '' : 'bg-slate-50 text-slate-500'}>
                <td className="px-4 py-3">
                  <input
                    defaultValue={person.fullName}
                    onBlur={(event) =>
                      event.target.value !== person.fullName &&
                      run(() => updateUserAction(person.id, { fullName: event.target.value }))
                    }
                    className="w-full max-w-[12rem] rounded border border-transparent px-1 py-0.5 hover:border-slate-300 focus:border-slate-400"
                  />
                  <p className="font-mono text-xs text-slate-400">{person.username}</p>
                </td>

                <td className="px-4 py-3">
                  <select
                    value={person.role}
                    disabled={pending}
                    onChange={(event) => run(() => updateUserAction(person.id, { role: event.target.value }))}
                    className="rounded border border-slate-300 px-2 py-1"
                  >
                    {Object.keys(ROLE_HINTS).map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </td>

                <td className="px-4 py-3">
                  <PlacePicker
                    places={places}
                    selected={person.locations.map((l) => l.id)}
                    locale={locale}
                    disabled={pending}
                    onChange={(ids) => run(() => setUserLocationsAction(person.id, ids))}
                  />
                </td>

                <td className="px-4 py-3">
                  {!person.isActive ? (
                    <span className="text-slate-500">Switched off</span>
                  ) : person.lockedUntil && person.lockedUntil > new Date() ? (
                    <span className="inline-flex items-center gap-1 text-amber-800">
                      <Lock aria-hidden className="h-3.5 w-3.5" />
                      Locked out
                    </span>
                  ) : person.mustChangePin ? (
                    <span className="text-slate-500">Awaiting first sign-in</span>
                  ) : person.lastLoginAt ? (
                    <span className="text-slate-600">
                      Last signed in{' '}
                      {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(
                        person.lastLoginAt,
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-500">Never signed in</span>
                  )}
                </td>

                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => resetPinAction(person.id, person.username))}
                      className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                    >
                      <KeyRound aria-hidden className="h-3.5 w-3.5" />
                      Reset PIN
                    </button>

                    {person.lockedUntil && person.lockedUntil > new Date() ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => unlockUserAction(person.id))}
                        className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                      >
                        <Lock aria-hidden className="h-3.5 w-3.5" />
                        Unlock
                      </button>
                    ) : null}

                    {/* An administrator locking themselves out is the one
                        irreversible mistake on this screen. */}
                    {person.id === currentUserId ? (
                      <span className="px-2 py-1 text-xs text-slate-400">This is you</span>
                    ) : (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => setUserActiveAction(person.id, !person.isActive))}
                        className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                      >
                        {person.isActive ? (
                          <>
                            <UserX aria-hidden className="h-3.5 w-3.5" />
                            Switch off
                          </>
                        ) : (
                          <>
                            <UserCheck aria-hidden className="h-3.5 w-3.5" />
                            Switch on
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddPersonForm({
  places,
  locale,
  onDone,
  onResult,
}: {
  places: PlaceOption[];
  locale: string;
  onDone: () => void;
  onResult: (state: UsersState) => void;
}) {
  const [state, formAction, pending] = useActionState<UsersState, FormData>(createUserAction, {});

  if (state.ok && !pending) {
    onResult(state);
    onDone();
  }

  return (
    <form
      action={formAction}
      className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 md:grid-cols-2"
    >
      <label className="flex flex-col gap-1.5">
        <span className="font-medium">Their name</span>
        <input name="fullName" required maxLength={120} className="rounded border border-slate-300 px-2 py-1.5" />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-medium">Sign-in name</span>
        <input
          name="username"
          required
          maxLength={40}
          pattern="[A-Za-z0-9_]+"
          placeholder="sunita"
          className="rounded border border-slate-300 px-2 py-1.5"
        />
        <span className="text-xs text-slate-500">
          Letters, numbers and underscores. This is what they type to sign in, so keep it short.
        </span>
      </label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="font-medium">What can they do?</legend>
        {Object.entries(ROLE_HINTS).map(([role, hint], index) => (
          <label key={role} className="flex items-start gap-2">
            <input type="radio" name="role" value={role} defaultChecked={index === 0} className="mt-1" />
            <span>
              <span className="block">{ROLE_LABELS[role]}</span>
              <span className="block text-xs text-slate-500">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="font-medium">Which places?</legend>
        <span className="text-xs text-slate-500">
          Assigning a place includes everything inside it.
        </span>
        <div className="max-h-40 overflow-y-auto rounded border border-slate-200 p-2">
          {places.length === 0 ? (
            <p className="text-xs text-slate-500">No places yet — add some first.</p>
          ) : (
            places.map((place) => (
              <label key={place.id} className="flex items-center gap-2 py-0.5">
                <input type="checkbox" name="locationIds" value={place.id} />
                <span style={{ paddingLeft: `${place.level * 0.75}rem` }}>
                  {localise(place.name, locale)}
                </span>
              </label>
            ))
          )}
        </div>
      </fieldset>

      <div className="flex gap-2 md:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Add and issue a PIN'}
        </button>
        <button type="button" onClick={onDone} className="rounded-lg border border-slate-300 px-4 py-2">
          Cancel
        </button>
      </div>

      {state.error ? (
        <p role="alert" className="text-deny-700 md:col-span-2">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Compact multi-select over the location tree, indented by depth. */
function PlacePicker({
  places,
  selected,
  locale,
  disabled,
  onChange,
}: {
  places: PlaceOption[];
  selected: string[];
  locale: string;
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left text-brand-700 hover:underline"
      >
        {selected.length === 0
          ? 'Whole organisation'
          : places
              .filter((p) => selected.includes(p.id))
              .map((p) => localise(p.name, locale))
              .join(', ')}
      </button>
    );
  }

  return (
    <div className="max-h-40 w-52 overflow-y-auto rounded border border-slate-300 bg-white p-2">
      {places.map((place) => (
        <label key={place.id} className="flex items-center gap-2 py-0.5">
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.includes(place.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, place.id]
                  : selected.filter((id) => id !== place.id),
              )
            }
          />
          <span style={{ paddingLeft: `${place.level * 0.75}rem` }}>
            {localise(place.name, locale)}
          </span>
        </label>
      ))}
      <button type="button" onClick={() => setOpen(false)} className="mt-1 text-xs text-slate-500">
        Done
      </button>
    </div>
  );
}
