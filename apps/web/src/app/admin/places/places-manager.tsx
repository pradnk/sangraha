'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import type { LocationLevel, LocationNode } from '@sangraha/db';
import { localise, pruneBlank } from '@sangraha/form-engine';
import { LANGUAGE_NAMES, UI_LOCALES } from '@/lib/i18n';
import {
  addPlaceAction,
  deletePlaceAction,
  renamePlaceAction,
  setPlaceActiveAction,
  type PlacesState,
} from './actions';

/**
 * The place hierarchy.
 *
 * Rendered as an indented list rather than a collapsible tree: an NGO's
 * hierarchy is three or four levels deep, and seeing all of it at once is more
 * useful than being able to fold parts away. Rows arrive pre-ordered
 * depth-first by their ltree path, so indenting on `level` is all that is needed.
 */
export function PlacesManager({
  places,
  levels,
  locale,
}: {
  places: LocationNode[];
  levels: LocationLevel[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<PlacesState>({});
  const [addingUnder, setAddingUnder] = useState<string | null | undefined>(undefined);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const run = (action: () => Promise<PlacesState>) =>
    startTransition(async () => {
      setMessage(await action());
      router.refresh();
    });

  const levelName = (level: number) =>
    levels[level] ? localise(levels[level]!.label, locale, levels[level]!.key) : `Level ${level + 1}`;

  const submitNew = (parentId: string | null) => {
    if (!newName.trim()) return;
    run(() => addPlaceAction(parentId, newName.trim()));
    setNewName('');
    setAddingUnder(undefined);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Places</h1>
          <p className="mt-1 text-slate-600">
            Where your work happens. Assigning someone a place gives them everything inside it, so a
            block coordinator needs one assignment rather than one per village.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddingUnder(null)}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
        >
          <Plus aria-hidden className="h-4 w-4" />
          Add {levelName(0).toLowerCase()}
        </button>
      </div>

      {message.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}

      {addingUnder === null ? (
        <NewPlaceRow
          label={`New ${levelName(0).toLowerCase()}`}
          value={newName}
          onChange={setNewName}
          onSubmit={() => submitNew(null)}
          onCancel={() => setAddingUnder(undefined)}
          pending={pending}
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {places.length === 0 ? (
          <p className="p-8 text-center text-slate-500">
            No places yet. Add a {levelName(0).toLowerCase()} to begin.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {places.map((place) => (
              <li key={place.id} className={place.isActive ? '' : 'bg-slate-50'}>
                <div
                  className="flex flex-wrap items-center gap-3 px-4 py-2.5"
                  style={{ paddingLeft: `${1 + place.level * 1.5}rem` }}
                >
                  <span className="min-w-0 flex-1">
                    {editingId === place.id ? (
                      <span className="flex flex-col gap-1.5">
                        {UI_LOCALES.map((loc) => (
                          <label key={loc} className="flex items-center gap-2">
                            <span className="w-14 shrink-0 text-xs text-slate-500">
                              {LANGUAGE_NAMES[loc]}
                            </span>
                            <input
                              defaultValue={place.name[loc] ?? ''}
                              onBlur={(event) =>
                                run(() =>
                                  renamePlaceAction(
                                    place.id,
                                    pruneBlank({ ...place.name, [loc]: event.target.value }),
                                    place.externalCode,
                                  ),
                                )
                              }
                              className="w-full max-w-xs rounded border border-slate-300 px-2 py-1"
                            />
                          </label>
                        ))}
                        <label className="flex items-center gap-2">
                          <span className="w-14 shrink-0 text-xs text-slate-500">Code</span>
                          <input
                            defaultValue={place.externalCode ?? ''}
                            placeholder="UDISE, LGD, census…"
                            onBlur={(event) =>
                              run(() =>
                                renamePlaceAction(place.id, place.name, event.target.value || null),
                              )
                            }
                            className="w-full max-w-xs rounded border border-slate-300 px-2 py-1"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="self-start text-xs text-slate-500"
                        >
                          Done
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditingId(place.id)}
                        className="text-left"
                      >
                        <span className="font-medium">{localise(place.name, locale)}</span>
                        <span className="ml-2 text-xs text-slate-500">{levelName(place.level)}</span>
                        {place.externalCode ? (
                          <span className="ml-2 font-mono text-xs text-slate-400">
                            {place.externalCode}
                          </span>
                        ) : null}
                        {place.isActive ? null : (
                          <span className="ml-2 text-xs text-slate-500">switched off</span>
                        )}
                      </button>
                    )}
                  </span>

                  <span className="flex shrink-0 gap-1.5">
                    {/* Only offered while there is a level below to add into. */}
                    {place.level + 1 < Math.max(levels.length, place.level + 2) ? (
                      <button
                        type="button"
                        onClick={() => {
                          setAddingUnder(place.id);
                          setNewName('');
                        }}
                        className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                      >
                        <Plus aria-hidden className="h-3.5 w-3.5" />
                        Add {levelName(place.level + 1).toLowerCase()}
                      </button>
                    ) : null}

                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => setPlaceActiveAction(place.id, !place.isActive))}
                      className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                    >
                      {place.isActive ? (
                        <>
                          <EyeOff aria-hidden className="h-3.5 w-3.5" />
                          Switch off
                        </>
                      ) : (
                        <>
                          <Eye aria-hidden className="h-3.5 w-3.5" />
                          Switch on
                        </>
                      )}
                    </button>

                    {/* Hidden when anything references it; the server refuses
                        anyway and explains why. */}
                    {place.inUse ? null : (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => deletePlaceAction(place.id))}
                        className="inline-flex items-center gap-1.5 rounded border border-deny-300 px-2 py-1 text-xs text-deny-700"
                      >
                        <Trash2 aria-hidden className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    )}
                  </span>
                </div>

                {addingUnder === place.id ? (
                  <div style={{ paddingLeft: `${2.5 + place.level * 1.5}rem` }} className="pb-3 pr-4">
                    <NewPlaceRow
                      label={`New ${levelName(place.level + 1).toLowerCase()} in ${localise(place.name, locale)}`}
                      value={newName}
                      onChange={setNewName}
                      onSubmit={() => submitNew(place.id)}
                      onCancel={() => setAddingUnder(undefined)}
                      pending={pending}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewPlaceRow({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  pending,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-300 bg-brand-50 p-3"
    >
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-sm text-slate-600">{label}</span>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={200}
          autoFocus
          className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
      >
        Add
      </button>
      <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5">
        Cancel
      </button>
    </form>
  );
}
