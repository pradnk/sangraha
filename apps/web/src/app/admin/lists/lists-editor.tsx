'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Plus,
  Trash2,
} from 'lucide-react';
import type { OptionSetDetail } from '@sangraha/db';
import { localise, pruneBlank } from '@sangraha/form-engine';
import { LANGUAGE_NAMES, UI_LOCALES } from '@/lib/i18n';
import {
  addOptionAction,
  createListAction,
  deleteOptionAction,
  relabelOptionAction,
  renameListAction,
  reorderOptionsAction,
  setOptionActiveAction,
  type ListsState,
} from './actions';

export function ListsEditor({
  sets,
  locale,
}: {
  sets: OptionSetDetail[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<ListsState>({});
  const [openId, setOpenId] = useState<string | null>(sets[0]?.id ?? null);
  const [newListName, setNewListName] = useState('');
  const [newOption, setNewOption] = useState('');

  const run = (action: () => Promise<ListsState>) =>
    startTransition(async () => {
      setMessage(await action());
      router.refresh();
    });

  const open = sets.find((set) => set.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div>
          <h1 className="text-xl font-bold">Answer lists</h1>
          <p className="mt-1 text-slate-600">
            When a question says <em>Choose one answer</em> or <em>Choose several answers</em>,
            this is where those choices come from.
          </p>
        </div>

        {/*
         * A worked example rather than a definition. "Reusable option set" is
         * accurate and tells a programme manager nothing; seeing the same list
         * feeding two different forms is the whole idea in one glance.
         */}
        <div className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              For example
            </p>
            <p className="mt-1 font-medium">A list called “Class”</p>
            <p className="text-slate-600">Class 1 · Class 2 · Class 3 … Class 8</p>
            <p className="mt-2 text-slate-600">
              Used by the <em>Which class?</em> question on your registration form, and again by
              the same question on your attendance form.
            </p>
          </div>

          <div className="rounded-lg bg-slate-50 p-3 text-slate-700">
            <p className="font-medium">Why one list, used twice</p>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
              <li>
                Add <em>Class 9</em> once and every form that uses the list offers it — no hunting
                through forms.
              </li>
              <li>
                Rename <em>Class 1</em> to <em>Standard 1</em>, or translate it, and every answer
                already collected reads the new way. Nothing is re-keyed.
              </li>
              <li>
                Reports can count across forms, because both forms recorded the same underlying
                answer rather than two strings that happen to look alike.
              </li>
            </ul>
          </div>
        </div>

        <p className="text-sm text-slate-500">
          You do not have to come here first — a question can have its list made from the form
          builder. This page is for when a list is shared, or needs a choice added or translated.
        </p>
      </div>

      {message.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Lists</h2>

          <ul className="flex flex-col gap-1">
            {sets.map((set) => (
              <li key={set.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(set.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border p-2.5 text-left ${
                    set.id === openId
                      ? 'border-brand-500 bg-brand-50'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {localise(set.name, locale, set.code)}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {set.options.length} answers
                      {set.usedByFieldCount > 0
                        ? ` · used by ${set.usedByFieldCount} question${set.usedByFieldCount === 1 ? '' : 's'}`
                        : ' · not used yet'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!newListName.trim()) return;
              run(() => createListAction(newListName.trim()));
              setNewListName('');
            }}
            className="flex gap-2 border-t border-slate-200 pt-3"
          >
            <input
              value={newListName}
              onChange={(event) => setNewListName(event.target.value)}
              placeholder="New list name"
              maxLength={120}
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5"
            />
            <button
              type="submit"
              disabled={pending}
              className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              <Plus aria-hidden className="h-4 w-4" />
            </button>
          </form>
        </section>

        <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4">
          {!open ? (
            <p className="rounded-lg bg-slate-50 p-6 text-center text-slate-500">
              Create a list to get started.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold">List name</h2>
                {UI_LOCALES.map((loc) => (
                  <label key={loc} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs text-slate-500">
                      {LANGUAGE_NAMES[loc]}
                    </span>
                    <input
                      defaultValue={open.name[loc] ?? ''}
                      onBlur={(event) =>
                        run(() =>
                          renameListAction(open.id, pruneBlank({ ...open.name, [loc]: event.target.value })),
                        )
                      }
                      className="w-full max-w-md rounded border border-slate-300 px-2 py-1.5"
                    />
                  </label>
                ))}
                {open.usedByFieldCount > 0 ? (
                  <p className="text-xs text-slate-500">
                    Used by {open.usedByFieldCount} question
                    {open.usedByFieldCount === 1 ? '' : 's'}. Changes here appear in all of them.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-2 border-t border-slate-200 pt-4">
                <h2 className="text-sm font-semibold">Answers</h2>

                {open.options.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 p-4 text-center text-slate-500">
                    No answers yet.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {open.options.map((option, index) => (
                      <li
                        key={option.id}
                        className={`flex flex-col gap-2 rounded-lg border p-3 ${
                          option.isActive ? 'border-slate-200' : 'border-slate-200 bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            {UI_LOCALES.map((loc) => (
                              <label key={loc} className="flex items-center gap-2">
                                <span className="w-14 shrink-0 text-xs text-slate-500">
                                  {LANGUAGE_NAMES[loc]}
                                </span>
                                <input
                                  defaultValue={option.label[loc] ?? ''}
                                  onBlur={(event) =>
                                    run(() =>
                                      relabelOptionAction(
                                        option.id,
                                        pruneBlank({ ...option.label, [loc]: event.target.value }),
                                      ),
                                    )
                                  }
                                  className="w-full max-w-sm rounded border border-slate-300 px-2 py-1"
                                />
                              </label>
                            ))}
                            {/* Shown quietly: it is what an analyst sees, and an
                                admin occasionally needs to match them up. */}
                            <p className="font-mono text-xs text-slate-400">
                              {option.code}
                              {option.answerCount > 0
                                ? ` · ${option.answerCount} record${option.answerCount === 1 ? '' : 's'}`
                                : ''}
                              {option.isActive ? '' : ' · hidden'}
                            </p>
                          </div>

                          <div className="flex shrink-0 flex-col gap-1">
                            <span className="flex gap-1">
                              <button
                                type="button"
                                aria-label="Move up"
                                disabled={pending || index === 0}
                                onClick={() =>
                                  run(() =>
                                    reorderOptionsAction(open.id, swap(open.options.map((o) => o.id), index, index - 1)),
                                  )
                                }
                                className="rounded border border-slate-300 p-1 disabled:opacity-30"
                              >
                                <ChevronUp aria-hidden className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                aria-label="Move down"
                                disabled={pending || index === open.options.length - 1}
                                onClick={() =>
                                  run(() =>
                                    reorderOptionsAction(open.id, swap(open.options.map((o) => o.id), index, index + 1)),
                                  )
                                }
                                className="rounded border border-slate-300 p-1 disabled:opacity-30"
                              >
                                <ChevronDown aria-hidden className="h-4 w-4" />
                              </button>
                            </span>

                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => run(() => setOptionActiveAction(option.id, !option.isActive))}
                              className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2 py-1 text-xs"
                            >
                              {option.isActive ? (
                                <>
                                  <EyeOff aria-hidden className="h-3.5 w-3.5" />
                                  Hide
                                </>
                              ) : (
                                <>
                                  <Eye aria-hidden className="h-3.5 w-3.5" />
                                  Show
                                </>
                              )}
                            </button>

                            {/* Offered only when nothing would be lost; the
                                server refuses otherwise and explains. */}
                            {option.answerCount === 0 ? (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => run(() => deleteOptionAction(open.id, option.id))}
                                className="inline-flex items-center gap-1.5 rounded border border-deny-300 px-2 py-1 text-xs text-deny-700"
                              >
                                <Trash2 aria-hidden className="h-3.5 w-3.5" />
                                Delete
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newOption.trim()) return;
                    run(() => addOptionAction(open.id, newOption.trim()));
                    setNewOption('');
                  }}
                  className="flex gap-2 pt-2"
                >
                  <input
                    value={newOption}
                    onChange={(event) => setNewOption(event.target.value)}
                    placeholder="Add an answer"
                    maxLength={200}
                    className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5"
                  />
                  <button
                    type="submit"
                    disabled={pending}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                  >
                    <Plus aria-hidden className="h-4 w-4" />
                    Add
                  </button>
                </form>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function swap(ids: string[], a: number, b: number): string[] {
  const next = [...ids];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}
